#!/usr/bin/env bash
set -euo pipefail

# Portable CODE validation for web app repositories (bun or npm lockfile).
# No runner home, socket, environment, writable host workspace or job-control files enter the container.
image="node:26-bookworm@sha256:fa52d1669505e29b58c042875b1d65c229e0787a3610fd52869b22b68e480853"
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
  --mount "type=bind,src=$(command -v bun),dst=/usr/local/bin/bun,readonly" \
  --env HOME=/tmp/home --env CI=true \
  "$image" sh -eu -c '
    mkdir -p /tmp/home /tmp/work
    cp -R /source/. /tmp/work/
    cd /tmp/work
    node -e "const fs=require(\"fs\");
      for (const k of Object.keys(process.env)) if (/TOKEN|SECRET|KEY|ACTIONS_|GITHUB_/.test(k)) throw Error(\"credential environment exposed\");
      if (fs.existsSync(\"/var/run/docker.sock\")) throw Error(\"Docker socket exposed\");
      for (const p of [\"/proc/1/root/home/runner\", \"/home/runner/work/_temp\"]) if (fs.existsSync(p)) throw Error(\"runner filesystem exposed\");
      const nets=Object.keys(require(\"os\").networkInterfaces()); if(nets.some(n=>n!==\"lo\")) throw Error(\"network exposed\");
      try {fs.writeFileSync(\"/source/.code-escape\", \"escape\"); throw Error(\"writable host source\");} catch(e) {if(e.code!==\"EROFS\" && e.code!==\"EACCES\") throw e;}
      console.log(\"Credential, filesystem and network isolation verified\");"
    if [ -f bun.lock ] || [ -f bun.lockb ]; then runner="bun run"; else runner="npm run"; fi
    has() { node -e "const s=(JSON.parse(require(\"fs\").readFileSync(\"package.json\",\"utf8\")).scripts)||{}; process.exit(s[process.argv[1]]?0:1)" "$1"; }
    if has test; then echo "== tests"; $runner test; else echo "== tests: this project has no test script (not run)"; fi
    if has typecheck; then echo "== typecheck"; $runner typecheck; elif has lint; then echo "== lint"; $runner lint; else echo "== typecheck/lint: no script (not run)"; fi
    if has build; then echo "== build"; $runner build; else echo "== build: no build script, validation cannot pass" >&2; exit 1; fi
  ' > "$output/validation.txt" 2>&1
status=$?
set -e
printf 'exit=%s\n' "$status" > "$output/exit-code.txt"
exit "$status"
