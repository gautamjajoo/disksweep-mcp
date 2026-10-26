/*
 * dsize — clone-aware disk usage for APFS, the sizing engine behind disksweep.
 *
 * Like `du -x -a`, prints "<bytes>\t<path>" for every file and folder in
 * post-order. Differences that matter on modern macOS:
 *   - Exact APFS clones are counted once (by clone id); partially modified
 *     clones are counted in full, so sizes are never undercounted.
 *   - Hard links are counted once (by file id).
 *   - iCloud "dataless" (evicted) files count as 0 and dataless folders are
 *     not entered, so scanning never triggers downloads.
 *   - Stays on one device (-x semantics), never follows symlinks.
 *   - Uses getattrlistbulk: one syscall returns a batch of directory entries
 *     with all needed metadata (no per-file stat).
 * Unreadable folders are reported on stderr as "dsize: <path>: <error>".
 *
 * Usage: dsize [-s] [-m] <path>...
 *   -0  end each record with NUL instead of newline (file names may contain newlines)
 *   -m  also print modification time (unix seconds) as a middle column; for a
 *       folder it is the newest modification anywhere inside it
 *   -s  print only each root's total, measuring each root independently
 *       (without -s, hard links/clones are deduplicated across all roots)
 */
#include <sys/attr.h>
#include <sys/stat.h>
#include <sys/vnode.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifndef ATTR_CMNEXT_PRIVATESIZE
#error "macOS 10.15+ SDK required"
#endif

/* ---- tiny open-addressing set of uint64 ---- */
typedef struct { uint64_t *slots; size_t cap, len; } u64set;

static int set_add(u64set *s, uint64_t v) { /* returns 1 if newly added */
    if (v == 0) v = UINT64_MAX; /* 0 marks empty */
    if (s->len * 2 >= s->cap) {
        size_t ncap = s->cap ? s->cap * 2 : 4096;
        uint64_t *n = calloc(ncap, sizeof *n);
        if (!n) { perror("dsize"); exit(2); }
        for (size_t i = 0; i < s->cap; i++) {
            uint64_t x = s->slots[i];
            if (!x) continue;
            size_t j = (x * 0x9E3779B97F4A7C15ULL) & (ncap - 1);
            while (n[j]) j = (j + 1) & (ncap - 1);
            n[j] = x;
        }
        free(s->slots);
        s->slots = n;
        s->cap = ncap;
    }
    size_t j = (v * 0x9E3779B97F4A7C15ULL) & (s->cap - 1);
    while (s->slots[j]) {
        if (s->slots[j] == v) return 0;
        j = (j + 1) & (s->cap - 1);
    }
    s->slots[j] = v;
    s->len++;
    return 1;
}

static u64set hardlinks, clones;
static dev_t root_dev;
static int print_all = 1;
static int show_mtime = 0;
static char term = '\n';
static char outbuf[1 << 16];

static void emit(uint64_t bytes, long mtime, const char *path) {
    if (show_mtime) printf("%llu\t%ld\t%s%c", (unsigned long long)bytes, mtime, path, term);
    else printf("%llu\t%s%c", (unsigned long long)bytes, path, term);
}

static void report(const char *path, int err) {
    fprintf(stderr, "dsize: %s: %s\n", path, strerror(err));
}

/* Bytes only this file uses. Computing it walks the file's extents, so it is
 * fetched only for files that may share blocks (rare), not in the bulk call. */
static int private_size(const char *path, uint64_t *out) {
    struct attrlist al = {0};
    al.bitmapcount = ATTR_BIT_MAP_COUNT;
    al.forkattr = ATTR_CMNEXT_PRIVATESIZE;
    struct __attribute__((packed)) { uint32_t len; off_t priv; } b;
    if (getattrlist(path, &al, &b, sizeof b, FSOPT_ATTR_CMN_EXTENDED | FSOPT_NOFOLLOW) != 0) return 0;
    *out = (uint64_t)b.priv;
    return 1;
}

/* Size one regular file's contribution. */
static uint64_t file_bytes(const char *path, uint64_t alloc, uint64_t ext_flags, uint64_t clone_id, int have_clone) {
    if (!(ext_flags & EF_MAY_SHARE_BLOCKS)) return alloc;
    /* Exact clones (Finder "Duplicate", cp -c, pnpm/Xcode clones) share all
     * blocks and a clone id: count the shared blocks once per id. Partially
     * modified clones get distinct ids and no attribute reveals which blocks
     * they share, so they are counted in full (like du): never undercounted. */
    if (!(ext_flags & EF_SHARES_ALL_BLOCKS) || !have_clone) return alloc;
    if (set_add(&clones, clone_id)) return alloc;
    uint64_t priv;
    return private_size(path, &priv) ? priv : 0;
}

/* Size `path`, a directory on root_dev. *latest receives the newest
 * modification time anywhere inside it (the folder's "last activity"). */
static uint64_t scan_dir(char *path, size_t plen, int depth, long *latest) {
    int fd = open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    if (fd < 0) { report(path, errno); return 0; }

    struct attrlist al = {0};
    al.bitmapcount = ATTR_BIT_MAP_COUNT;
    al.commonattr = ATTR_CMN_RETURNED_ATTRS | ATTR_CMN_NAME | ATTR_CMN_DEVID | ATTR_CMN_OBJTYPE |
                    ATTR_CMN_MODTIME | ATTR_CMN_FLAGS | ATTR_CMN_FILEID;
    al.fileattr = ATTR_FILE_LINKCOUNT | ATTR_FILE_ALLOCSIZE;
    al.forkattr = ATTR_CMNEXT_CLONEID | ATTR_CMNEXT_EXT_FLAGS;

    const size_t bufsz = 64 * 1024; /* one per open directory level */
    char *mybuf = malloc(bufsz);
    if (!mybuf) { perror("dsize"); exit(2); }

    uint64_t total = 0;
    for (;;) {
        int n = getattrlistbulk(fd, &al, mybuf, bufsz, FSOPT_PACK_INVAL_ATTRS | FSOPT_ATTR_CMN_EXTENDED);
        if (n < 0) { report(path, errno); break; }
        if (n == 0) break;
        char *entry = mybuf;
        for (int i = 0; i < n; i++) {
            char *p = entry;
            uint32_t length = *(uint32_t *)p; p += sizeof(uint32_t);
            attribute_set_t returned = *(attribute_set_t *)p; p += sizeof(attribute_set_t);

            /* With FSOPT_PACK_INVAL_ATTRS every requested attribute is present in
             * the buffer; `returned` says which ones hold valid values. */
#define TAKE(type, var, set, bit) type var; memset(&var, 0, sizeof var); \
            if ((returned.set) & (bit)) var = *(type *)p; \
            p += sizeof(type);
            const char *name = NULL;
            {
                attrreference_t *ref = (attrreference_t *)p;
                if (returned.commonattr & ATTR_CMN_NAME) name = (char *)p + ref->attr_dataoffset;
                p += sizeof(attrreference_t);
            }
            TAKE(dev_t, dev, commonattr, ATTR_CMN_DEVID)
            TAKE(fsobj_type_t, type, commonattr, ATTR_CMN_OBJTYPE)
            TAKE(struct timespec, mtime, commonattr, ATTR_CMN_MODTIME)
            TAKE(uint32_t, flags, commonattr, ATTR_CMN_FLAGS)
            TAKE(uint64_t, fileid, commonattr, ATTR_CMN_FILEID)
            TAKE(uint32_t, links, fileattr, ATTR_FILE_LINKCOUNT)
            TAKE(off_t, alloc, fileattr, ATTR_FILE_ALLOCSIZE)
            TAKE(uint64_t, clone_id, forkattr, ATTR_CMNEXT_CLONEID)
            TAKE(uint64_t, ext_flags, forkattr, ATTR_CMNEXT_EXT_FLAGS)
#undef TAKE
            int have_clone = (returned.forkattr & ATTR_CMNEXT_CLONEID) != 0;
            if (!(returned.commonattr & ATTR_CMN_DEVID)) dev = root_dev;
            if (!(returned.fileattr & ATTR_FILE_LINKCOUNT)) links = 1;

            entry += length;
            if (!name) continue;

            size_t nlen = strlen(name);
            if (plen + 1 + nlen + 1 >= PATH_MAX) { report(path, ENAMETOOLONG); continue; }
            size_t at = plen;
            if (!(plen == 1 && path[0] == '/')) path[at++] = '/';
            memcpy(path + at, name, nlen + 1);
            size_t clen = at + nlen;

            uint64_t bytes = 0;
            long when = (long)mtime.tv_sec;
            if (type == VDIR) {
                if (dev != root_dev || (flags & SF_DATALESS)) {
                    bytes = 0; /* other volume, or iCloud folder not downloaded */
                } else {
                    bytes = scan_dir(path, clen, depth + 1, &when);
                }
            } else if (type == VREG) {
                if (flags & SF_DATALESS) bytes = 0;
                else if (links > 1 && !set_add(&hardlinks, fileid)) bytes = 0;
                else bytes = file_bytes(path, (uint64_t)alloc, ext_flags, clone_id, have_clone);
                if (print_all) emit(bytes, when, path);
            } else {
                /* symlinks, sockets, devices: negligible, not followed */
                bytes = (uint64_t)alloc;
                if (print_all) emit(bytes, when, path);
            }
            if (when > *latest) *latest = when;
            total += bytes;
            path[plen] = '\0';
        }
    }
    free(mybuf);
    close(fd);
    if (print_all || depth == 0) emit(total, *latest, path);
    return total;
}

int main(int argc, char **argv) {
    setvbuf(stdout, outbuf, _IOFBF, sizeof outbuf);
    int first = 1;
    for (; first < argc && argv[first][0] == '-' && argv[first][1] && argv[first][1] != '-'; first++) {
        if (strcmp(argv[first], "-s") == 0) print_all = 0;
        else if (strcmp(argv[first], "-m") == 0) show_mtime = 1;
        else if (strcmp(argv[first], "-0") == 0) term = '\0';
        else { fprintf(stderr, "dsize: unknown option %s\n", argv[first]); return 2; }
    }
    if (first < argc && strcmp(argv[first], "--") == 0) first++;
    if (first >= argc) { fprintf(stderr, "usage: dsize [-s] [-m] [-0] <path>...\n"); return 2; }
    int status = 0;
    for (int i = first; i < argc; i++) {
        struct stat st;
        if (lstat(argv[i], &st) != 0) { report(argv[i], errno); status = 1; continue; }
        root_dev = st.st_dev;
        if (!print_all) { /* -s: each root measured independently */
            free(hardlinks.slots); free(clones.slots);
            memset(&hardlinks, 0, sizeof hardlinks); memset(&clones, 0, sizeof clones);
        }
        size_t arglen = strlen(argv[i]);
        if (arglen >= PATH_MAX) { report(argv[i], ENAMETOOLONG); status = 1; continue; }
        char *path = malloc(PATH_MAX);
        if (!path) { perror("dsize"); return 2; }
        memcpy(path, argv[i], arglen + 1);
        size_t len = arglen;
        while (len > 1 && path[len - 1] == '/') path[--len] = '\0';
        if (S_ISDIR(st.st_mode)) {
            long latest = (long)st.st_mtimespec.tv_sec;
            scan_dir(path, len, 0, &latest);
        } else {
            uint64_t bytes = (uint64_t)st.st_blocks * 512;
            if (st.st_flags & SF_DATALESS) bytes = 0;
            else if (st.st_nlink > 1 && !set_add(&hardlinks, st.st_ino)) bytes = 0;
            emit(bytes, (long)st.st_mtimespec.tv_sec, path);
        }
        free(path);
    }
    fflush(stdout);
    return status;
}
