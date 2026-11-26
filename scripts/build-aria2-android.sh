#!/usr/bin/env bash
set -euo pipefail

# Cross-compiles the latest stable release of aria2c from
# https://github.com/aria2/aria2.git for Android (arm64-v8a, armeabi-v7a, x86_64)
# as self-contained PIE executables linked statically with OpenSSL + zlib + libc++
# and aligned to 16 KB ELF pages (Android 15/16+ compatible).
#
# Output:
#   android/app/src/main/jniLibs/<abi>/libaria2c.so

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT_JNILIBS="$ROOT_DIR/android/app/src/main/jniLibs"

ARIA2_REPO="https://github.com/aria2/aria2.git"
ARIA2_TAG="${1:-${ARIA2_TAG:-}}"
ANDROID_API="${ANDROID_API:-26}"
ARIA2_ABIS="${ARIA2_ABIS:-arm64-v8a armeabi-v7a x86_64}"
OPENSSL_VERSION="${OPENSSL_VERSION:-3.0.15}"
ZLIB_VERSION="${ZLIB_VERSION:-1.3.1}"

if [ -z "$ARIA2_TAG" ]; then
  ARIA2_TAG="$(node "$SCRIPT_DIR/resolve-download-engines.mjs" --json | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); process.stdout.write(d.aria2Tag);")"
fi
if [ -z "$ARIA2_TAG" ]; then
  echo "::error::Não foi possível determinar a versão estável mais recente de $ARIA2_REPO"
  exit 1
fi

# Locate Android NDK
NDK_DIR="${ANDROID_NDK_LATEST_HOME:-${ANDROID_NDK_HOME:-${ANDROID_NDK_ROOT:-}}}"
if [ -z "$NDK_DIR" ] || [ ! -d "$NDK_DIR/toolchains/llvm/prebuilt" ]; then
  SDK_BASE="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
  if [ -n "$SDK_BASE" ] && [ -d "$SDK_BASE/ndk" ]; then
    NDK_DIR="$(ls -d "$SDK_BASE"/ndk/* 2>/dev/null | sort -V | tail -n 1 || true)"
  fi
fi
if [ -z "$NDK_DIR" ] || [ ! -d "$NDK_DIR/toolchains/llvm/prebuilt" ]; then
  echo "::error::Android NDK não encontrado. Defina ANDROID_NDK_HOME ou instale o NDK no ANDROID_HOME."
  exit 1
fi

TOOLCHAIN="$(ls -d "$NDK_DIR"/toolchains/llvm/prebuilt/* | head -n 1)"
if [ ! -d "$TOOLCHAIN/bin" ]; then
  echo "::error::Toolchain LLVM do Android NDK não encontrada em $NDK_DIR"
  exit 1
fi

CPU_COUNT="$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)"
BUILD_GNU_TYPE="$(dpkg-architecture -qDEB_BUILD_GNU_TYPE 2>/dev/null || uname -m)-pc-linux-gnu"
if command -v dpkg-architecture >/dev/null 2>&1; then
  BUILD_GNU_TYPE="$(dpkg-architecture -qDEB_BUILD_GNU_TYPE)"
fi

WORK_DIR="${RUNNER_TEMP:-/tmp}/aria2-android-build-${ARIA2_TAG}"
SRC_DIR="$WORK_DIR/src"
mkdir -p "$SRC_DIR" "$OUT_JNILIBS"

echo "=== Compilando aria2c ($ARIA2_TAG) a partir de $ARIA2_REPO ==="
echo "NDK: $NDK_DIR"
echo "ABIs: $ARIA2_ABIS (API $ANDROID_API)"

# Download upstream tarballs once
ZLIB_TAR="$SRC_DIR/zlib-${ZLIB_VERSION}.tar.gz"
OPENSSL_TAR="$SRC_DIR/openssl-${OPENSSL_VERSION}.tar.gz"

if [ ! -f "$ZLIB_TAR" ]; then
  curl -fsSL --retry 3 "https://github.com/madler/zlib/releases/download/v${ZLIB_VERSION}/zlib-${ZLIB_VERSION}.tar.gz" -o "$ZLIB_TAR"
fi
if [ ! -f "$OPENSSL_TAR" ]; then
  curl -fsSL --retry 3 "https://github.com/openssl/openssl/releases/download/openssl-${OPENSSL_VERSION}/openssl-${OPENSSL_VERSION}.tar.gz" -o "$OPENSSL_TAR"
fi

# Clone official aria2 repo at exact latest stable tag
ARIA2_SRC="$SRC_DIR/aria2"
rm -rf "$ARIA2_SRC"
git clone --depth 1 --branch "$ARIA2_TAG" "$ARIA2_REPO" "$ARIA2_SRC"

pushd "$ARIA2_SRC" >/dev/null
autoreconf -i
popd >/dev/null

build_abi() {
  local ABI="$1"
  local HOST=""
  local CLANG_PREFIX=""
  local OPENSSL_TARGET=""
  local CHECK_16KB="0"

  case "$ABI" in
    arm64-v8a)
      HOST="aarch64-linux-android"
      CLANG_PREFIX="aarch64-linux-android${ANDROID_API}"
      OPENSSL_TARGET="android-arm64"
      CHECK_16KB="1"
      ;;
    armeabi-v7a)
      HOST="armv7a-linux-androideabi"
      CLANG_PREFIX="armv7a-linux-androideabi${ANDROID_API}"
      OPENSSL_TARGET="android-arm"
      CHECK_16KB="0"
      ;;
    x86_64)
      HOST="x86_64-linux-android"
      CLANG_PREFIX="x86_64-linux-android${ANDROID_API}"
      OPENSSL_TARGET="android-x86_64"
      CHECK_16KB="1"
      ;;
    *)
      echo "::error::ABI não suportada: $ABI"
      exit 1
      ;;
  esac

  echo "--- [${ABI}] Compilando zlib, OpenSSL ${OPENSSL_VERSION} e aria2 ${ARIA2_TAG} ---"
  local ABI_WORK="$WORK_DIR/$ABI"
  local PREFIX="$ABI_WORK/prefix"
  rm -rf "$ABI_WORK"
  mkdir -p "$ABI_WORK" "$PREFIX"

  local CC_BIN="$TOOLCHAIN/bin/${CLANG_PREFIX}-clang"
  local CXX_BIN="$TOOLCHAIN/bin/${CLANG_PREFIX}-clang++"
  local AR_BIN="$TOOLCHAIN/bin/llvm-ar"
  local RANLIB_BIN="$TOOLCHAIN/bin/llvm-ranlib"
  local STRIP_BIN="$TOOLCHAIN/bin/llvm-strip"
  local READELF_BIN="$TOOLCHAIN/bin/llvm-readelf"

  # 1. Static zlib
  tar -xzf "$ZLIB_TAR" -C "$ABI_WORK"
  pushd "$ABI_WORK/zlib-${ZLIB_VERSION}" >/dev/null
  CC="$CC_BIN" \
  AR="$AR_BIN" \
  RANLIB="$RANLIB_BIN" \
  CFLAGS="-Os -fPIC" \
  ./configure --prefix="$PREFIX" --static
  make -j"$CPU_COUNT" libz.a
  make install
  popd >/dev/null

  # 2. Static OpenSSL
  tar -xzf "$OPENSSL_TAR" -C "$ABI_WORK"
  pushd "$ABI_WORK/openssl-${OPENSSL_VERSION}" >/dev/null
  (
    export ANDROID_NDK_ROOT="$NDK_DIR"
    export ANDROID_NDK_HOME="$NDK_DIR"
    export PATH="$TOOLCHAIN/bin:$PATH"
    unset CC CXX CFLAGS CXXFLAGS LDFLAGS CPPFLAGS
    ./Configure "$OPENSSL_TARGET" \
      -D__ANDROID_API__="$ANDROID_API" \
      no-shared \
      no-tests \
      no-ui-console \
      no-legacy \
      --prefix="$PREFIX" \
      --libdir=lib
    make -j"$CPU_COUNT" build_libs
    make install_dev
  )
  popd >/dev/null

  # 3. aria2c static PIE executable (HTTP/HTTPS multi-connection optimized)
  local ARIA2_BUILD="$ABI_WORK/aria2-build"
  mkdir -p "$ARIA2_BUILD"
  pushd "$ARIA2_BUILD" >/dev/null
  (
    export CC="$CC_BIN"
    export CXX="$CXX_BIN"
    export AR="$AR_BIN"
    export RANLIB="$RANLIB_BIN"
    export STRIP="$STRIP_BIN"
    export PKG_CONFIG_PATH=""
    export PKG_CONFIG_LIBDIR="$PREFIX/lib/pkgconfig"
    export CPPFLAGS="-I$PREFIX/include -fPIE"
    export CFLAGS="-Os -fPIE"
    export CXXFLAGS="-Os -std=c++14 -fPIE"
    export LDFLAGS="-fPIE -pie -L$PREFIX/lib -static-libstdc++ -Wl,-z,max-page-size=16384"
    export OPENSSL_CFLAGS="-I$PREFIX/include"
    export OPENSSL_LIBS="-L$PREFIX/lib -lssl -lcrypto -ldl"
    export ZLIB_CFLAGS="-I$PREFIX/include"
    export ZLIB_LIBS="-L$PREFIX/lib -lz"
    export SPHINXBUILD="no"

    "$ARIA2_SRC/configure" \
      --host="$HOST" \
      --build="$BUILD_GNU_TYPE" \
      --prefix="$PREFIX" \
      --disable-nls \
      --disable-bittorrent \
      --disable-metalink \
      --disable-websocket \
      --without-gnutls \
      --with-openssl \
      --without-sqlite3 \
      --without-libxml2 \
      --without-libexpat \
      --without-libcares \
      --without-libssh2 \
      --with-libz

    make -j"$CPU_COUNT" -C src aria2c
  )

  local BIN_SRC="$ARIA2_BUILD/src/aria2c"
  if [ ! -f "$BIN_SRC" ]; then
    echo "::error::Falha ao gerar binário aria2c para $ABI"
    exit 1
  fi
  "$STRIP_BIN" "$BIN_SRC"

  # Verify no unexpected shared library dependencies (only bionic system libs allowed)
  local NEEDED_LIBS
  NEEDED_LIBS="$("$READELF_BIN" -d "$BIN_SRC" | grep '(NEEDED)' || true)"
  echo "[${ABI}] NEEDED libs:"
  echo "$NEEDED_LIBS"
  if echo "$NEEDED_LIBS" | grep -E 'libc\+\+_shared|libssl|libcrypto'; then
    echo "::error::Binário aria2c ($ABI) possui dependência dinâmica inesperada!"
    exit 1
  fi

  # Verify 16 KB ELF page alignment for 64-bit ABIs (Android 15/16+)
  if [ "$CHECK_16KB" = "1" ]; then
    local LOAD_SEGS
    LOAD_SEGS="$("$READELF_BIN" -l "$BIN_SRC" | grep 'LOAD' || true)"
    echo "[${ABI}] LOAD segments:"
    echo "$LOAD_SEGS"
    if echo "$LOAD_SEGS" | grep -q '0x1000$'; then
      echo "::error::Binário aria2c ($ABI) não está alinhado para páginas de 16 KB (0x4000)!"
      exit 1
    fi
  fi

  mkdir -p "$OUT_JNILIBS/$ABI"
  cp "$BIN_SRC" "$OUT_JNILIBS/$ABI/libaria2c.so"
  chmod 0755 "$OUT_JNILIBS/$ABI/libaria2c.so"
  ls -lh "$OUT_JNILIBS/$ABI/libaria2c.so"
  popd >/dev/null
}

for abi in $ARIA2_ABIS; do
  build_abi "$abi"
done

echo "=== aria2c ($ARIA2_TAG) compilado com sucesso para: $ARIA2_ABIS ==="
