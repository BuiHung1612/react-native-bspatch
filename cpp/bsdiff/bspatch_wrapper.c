#include <bzlib.h>
#include <stdlib.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <unistd.h>
#include <fcntl.h>
#include "bspatch.h"
#include "bspatch_wrapper.h"

#ifdef __ANDROID__
#include <android/log.h>
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, "bspatch", __VA_ARGS__)
#else
#define LOGE(...)
#endif

static int64_t wrapper_offtin(uint8_t *buf)
{
	int64_t y;

	y=buf[7]&0x7F;
	y=y*256;y+=buf[6];
	y=y*256;y+=buf[5];
	y=y*256;y+=buf[4];
	y=y*256;y+=buf[3];
	y=y*256;y+=buf[2];
	y=y*256;y+=buf[1];
	y=y*256;y+=buf[0];

	if(buf[7]&0x80) y=-y;

	return y;
}

static int bz2_read(const struct bspatch_stream* stream, void* buffer, int length)
{
	int n;
	int bz2err;
	BZFILE* bz2;

	bz2 = (BZFILE*)stream->opaque;
	n = BZ2_bzRead(&bz2err, bz2, buffer, length);
	if (n != length)
		return -1;

	return 0;
}

int apply_bspatch(const char *oldfile, const char *newfile, const char *patchfile)
{
	FILE * f;
	int fd = -1;
	int bz2err;
	uint8_t header[24];
	uint8_t *old = NULL, *new_buf = NULL;
	int64_t oldsize, newsize;
	BZFILE* bz2 = NULL;
	struct bspatch_stream stream;
	struct stat sb;

	/* Open patch file */
	if ((f = fopen(patchfile, "r")) == NULL) {
	    LOGE("Failed to open patch file: %s", patchfile);
		return -1;
	}

	/* Read header */
	if (fread(header, 1, 24, f) != 24) {
	    LOGE("Failed to read header from patch file");
		fclose(f);
		return -1;
	}

	/* Check for appropriate magic */
	if (memcmp(header, "ENDSLEY/BSDIFF43", 16) != 0) {
	    LOGE("Invalid magic in patch header");
		fclose(f);
		return -1;
	}

	/* Read lengths from header */
	newsize = wrapper_offtin(header + 16);
	if(newsize < 0) {
	    LOGE("Invalid newsize in patch header");
		fclose(f);
		return -1;
	}

	/* Close patch file and re-open it via libbzip2 at the right places */
	if(((fd=open(oldfile,O_RDONLY,0))<0) ||
		((oldsize=lseek(fd,0,SEEK_END))==-1) ||
		((old=malloc(oldsize+1))==NULL) ||
		(lseek(fd,0,SEEK_SET)!=0) ||
		(read(fd,old,oldsize)!=oldsize) ||
		(fstat(fd, &sb)) ||
		(close(fd)==-1)) {
		LOGE("Failed reading oldfile (fd=%d, oldsize=%lld)", fd, (long long)oldsize);
		if (fd >= 0) close(fd);
		if (old) free(old);
		fclose(f);
		return -1;
	}

	if((new_buf=malloc(newsize+1))==NULL) {
	    LOGE("Failed to allocate memory for new_buf (%lld)", (long long)newsize);
		free(old);
		fclose(f);
		return -1;
	}

	if (NULL == (bz2 = BZ2_bzReadOpen(&bz2err, f, 0, 0, NULL, 0))) {
	    LOGE("BZ2_bzReadOpen failed: err=%d", bz2err);
		free(new_buf);
		free(old);
		fclose(f);
		return -1;
	}

	stream.read = bz2_read;
	stream.opaque = bz2;
	if (bspatch(old, oldsize, new_buf, newsize, &stream)) {
	    LOGE("bspatch core logic failed");
		BZ2_bzReadClose(&bz2err, bz2);
		free(new_buf);
		free(old);
		fclose(f);
		return -1;
	}

	/* Clean up the bzip2 reads */
	BZ2_bzReadClose(&bz2err, bz2);
	fclose(f);

	/* Write the new file */
	if(((fd=open(newfile,O_CREAT|O_TRUNC|O_WRONLY,sb.st_mode))<0) ||
		(write(fd,new_buf,newsize)!=newsize) || (close(fd)==-1)) {
		if (fd >= 0) close(fd);
		free(new_buf);
		free(old);
		return -1;
	}

	free(new_buf);
	free(old);

	return 0; // Success
}
