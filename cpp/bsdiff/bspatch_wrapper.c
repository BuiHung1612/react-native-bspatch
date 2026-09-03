#include <bzlib.h>
#include <stdlib.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <sys/mman.h>
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
	int fd_old = -1;
	int fd_new = -1;
	int bz2err;
	uint8_t header[24];
	uint8_t *old = NULL;
	uint8_t *new_buf = NULL;
	int64_t oldsize = 0, newsize = 0;
	int old_mmapped = 0, new_mmapped = 0;
	BZFILE* bz2 = NULL;
	struct bspatch_stream stream;
	struct stat sb_old;

	/* Open patch file */
	if ((f = fopen(patchfile, "rb")) == NULL) {
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
	if (newsize < 0) {
		LOGE("Invalid newsize in patch header: %lld", (long long)newsize);
		fclose(f);
		return -1;
	}

	/* Open and map old file */
	if ((fd_old = open(oldfile, O_RDONLY, 0)) < 0) {
		LOGE("Failed to open oldfile: %s", oldfile);
		fclose(f);
		return -1;
	}

	if (fstat(fd_old, &sb_old) != 0) {
		LOGE("Failed to stat oldfile: %s", oldfile);
		close(fd_old);
		fclose(f);
		return -1;
	}
	oldsize = sb_old.st_size;

	if (oldsize > 0) {
		old = (uint8_t *)mmap(NULL, (size_t)oldsize, PROT_READ, MAP_SHARED, fd_old, 0);
		if (old != MAP_FAILED) {
			old_mmapped = 1;
#if defined(MADV_SEQUENTIAL)
			madvise(old, (size_t)oldsize, MADV_SEQUENTIAL);
#endif
		} else {
			/* Fallback to malloc if mmap fails */
			old = (uint8_t *)malloc((size_t)oldsize + 1);
			if (old == NULL || read(fd_old, old, (size_t)oldsize) != oldsize) {
				LOGE("Failed to read oldfile into memory");
				if (old) free(old);
				close(fd_old);
				fclose(f);
				return -1;
			}
			old_mmapped = 0;
		}
	}

	/* Open and map new file */
	mode_t mode = sb_old.st_mode ? sb_old.st_mode : 0644;
	if ((fd_new = open(newfile, O_RDWR | O_CREAT | O_TRUNC, mode)) < 0) {
		LOGE("Failed to open/create newfile: %s", newfile);
		if (old_mmapped) munmap(old, (size_t)oldsize);
		else if (old) free(old);
		close(fd_old);
		fclose(f);
		return -1;
	}

	if (newsize > 0) {
		if (ftruncate(fd_new, (off_t)newsize) != 0) {
			LOGE("Failed to ftruncate newfile to size %lld", (long long)newsize);
			if (old_mmapped) munmap(old, (size_t)oldsize);
			else if (old) free(old);
			close(fd_old);
			close(fd_new);
			fclose(f);
			return -1;
		}

		new_buf = (uint8_t *)mmap(NULL, (size_t)newsize, PROT_READ | PROT_WRITE, MAP_SHARED, fd_new, 0);
		if (new_buf != MAP_FAILED) {
			new_mmapped = 1;
#if defined(MADV_SEQUENTIAL)
			madvise(new_buf, (size_t)newsize, MADV_SEQUENTIAL);
#endif
		} else {
			/* Fallback to malloc if mmap fails */
			new_buf = (uint8_t *)malloc((size_t)newsize + 1);
			if (new_buf == NULL) {
				LOGE("Failed to allocate memory for new_buf (%lld)", (long long)newsize);
				if (old_mmapped) munmap(old, (size_t)oldsize);
				else if (old) free(old);
				close(fd_old);
				close(fd_new);
				fclose(f);
				return -1;
			}
			new_mmapped = 0;
		}
	}

	/* Initialize bzip2 stream */
	if (NULL == (bz2 = BZ2_bzReadOpen(&bz2err, f, 0, 0, NULL, 0))) {
		LOGE("BZ2_bzReadOpen failed: err=%d", bz2err);
		if (new_mmapped) munmap(new_buf, (size_t)newsize);
		else if (new_buf) free(new_buf);
		if (old_mmapped) munmap(old, (size_t)oldsize);
		else if (old) free(old);
		close(fd_old);
		close(fd_new);
		fclose(f);
		return -1;
	}

	stream.read = bz2_read;
	stream.opaque = bz2;
	if (bspatch(old, oldsize, new_buf, newsize, &stream)) {
		LOGE("bspatch core logic failed");
		BZ2_bzReadClose(&bz2err, bz2);
		if (new_mmapped) munmap(new_buf, (size_t)newsize);
		else if (new_buf) free(new_buf);
		if (old_mmapped) munmap(old, (size_t)oldsize);
		else if (old) free(old);
		close(fd_old);
		close(fd_new);
		fclose(f);
		return -1;
	}

	/* Clean up bzip2 and patch file */
	BZ2_bzReadClose(&bz2err, bz2);
	fclose(f);

	/* Finalize new file */
	int ret = 0;
	if (new_mmapped) {
		if (msync(new_buf, (size_t)newsize, MS_SYNC) != 0) {
			LOGE("msync failed on newfile");
			ret = -1;
		}
		munmap(new_buf, (size_t)newsize);
	} else if (new_buf) {
		if (write(fd_new, new_buf, (size_t)newsize) != newsize) {
			LOGE("Failed writing newfile");
			ret = -1;
		}
		free(new_buf);
	}

	/* Clean up old file and descriptors */
	if (old_mmapped) {
		munmap(old, (size_t)oldsize);
	} else if (old) {
		free(old);
	}
	close(fd_old);
	close(fd_new);

	return ret;
}
