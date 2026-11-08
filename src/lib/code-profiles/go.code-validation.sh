#!/usr/bin/env bash
set -euo pipefail

# Portable CODE validation for Go repositories. Modules were downloaded beforehand (no code run);
# vet, test and build run offline in a credential-free, read-only container.
image="golang:1.26-bookworm@sha256:5de7c99eb78ca5e515a4c340235d0955ec5964a5071c492c15503d7c267da473"
output="$RUNNER_TEMP/code-validation"
mkdir -p "$output"
docker pull "$image"
name="code-validate-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
set +e
timeout 900 docker run --name "$name" --rm --init \
  --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
  --user 1000:1000 --pids-limit 256 --memory 6g --cpus 2 \
  --tmpfs /tmp:rw,exec,nosuid,size=8g,mode=1777 \
  --mount "type=bind,src=$PWD,dst=/source,readonly" \
  --mount "type=bind,src=$RUNNER_TEMP/gomod,dst=/gomod,readonly" \
  --env HOME=/tmp/home --env CI=true --env GOMODCACHE=/gomod --env GOCACHE=/tmp/gocache \
  --env GOFLAGS=-mod=readonly --env GOPROXY=off --env GOTOOLCHAIN=local \
  "$image" sh -eu -c '
    mkdir -p /tmp/home /tmp/work /tmp/gocache
    for k in $(env | cut -d= -f1); do
      case "$k" in *TOKEN*|*SECRET*|*KEY*|ACTIONS_*|GITHUB_*) echo "credential environment exposed: $k" >&2; exit 1;; esac
    done
    [ ! -e /var/run/docker.sock ] || { echo "Docker socket exposed" >&2; exit 1; }
    for p in /proc/1/root/home/runner /home/runner/work/_temp; do [ ! -e "$p" ] || { echo "runner filesystem exposed" >&2; exit 1; }; done
    for n in $(ls /sys/class/net); do [ "$n" = lo ] || { echo "network exposed" >&2; exit 1; }; done
    if (echo escape > /source/.code-escape) 2>/dev/null; then echo "writable host source" >&2; exit 1; fi
    echo "Credential, filesystem and network isolation verified"
    cp -R /source/. /tmp/work/
    cd /tmp/work
    echo "== go vet"; go vet ./...
    echo "== go test"; go test ./...
    echo "== go build"; go build ./...
  ' > "$output/validation.txt" 2>&1
status=$?
set -e
printf 'exit=%s\n' "$status" > "$output/exit-code.txt"
exit "$status"
