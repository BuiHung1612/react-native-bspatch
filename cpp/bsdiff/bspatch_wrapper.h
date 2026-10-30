#ifndef BSPATCH_WRAPPER_H
#define BSPATCH_WRAPPER_H

int apply_bspatch(const char *oldfile, const char *newfile, const char *patchfile);
/* Streams a single-stream .bz2 file to dstfile. 0 on success; dstfile is removed on failure. */
int decompress_bz2(const char *srcfile, const char *dstfile);

#endif // BSPATCH_WRAPPER_H
