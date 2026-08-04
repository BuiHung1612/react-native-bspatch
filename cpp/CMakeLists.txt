cmake_minimum_required(VERSION 3.18.1)

project("bspatch")

# Define bzip2 sources explicitly to avoid including executables
set(BZIP2_SOURCES
    "bzip2/blocksort.c"
    "bzip2/huffman.c"
    "bzip2/crctable.c"
    "bzip2/randtable.c"
    "bzip2/compress.c"
    "bzip2/decompress.c"
    "bzip2/bzlib.c"
)

# React Native includes
set(REACT_NATIVE_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../../../../node_modules/react-native)

# Add our custom library
add_library(
        bspatch
        SHARED

        bspatch_jni.cpp
        bsdiff/bspatch_wrapper.c
        bsdiff/bspatch.c
        ${BZIP2_SOURCES}
)

# Include directories
target_include_directories(bspatch PRIVATE bzip2 bsdiff)

# Link against Android standard libraries
target_link_libraries(
        bspatch
        log
)

# Set 16KB (2^14) page alignment for Android compatibility
# Required for arm64-v8a and x86_64 architectures
if(ANDROID)
    target_link_options(bspatch PRIVATE "LINKER:-z,max-page-size=16384")
endif()
