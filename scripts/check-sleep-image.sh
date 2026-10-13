#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Whether an SGLang server image lets a card's models sleep (record 55, B6):
# its memory saver must flush the state pools before it releases the KV cache
# region, or a hybrid model's server crashes at the release (CUDA error 700)
# and the card falls back to cold swaps. This runs SGLang's own test of that
# order (sgl-project/sglang#40821, which fixed it on the sglang-miles branch)
# inside the image, on the CPU, with no network: it fails on 0.5.20 and 0.5.21
# and passes on an image with the fix. Pass before setting "sleep": "release".
#
#   scripts/check-sleep-image.sh IMAGE [docker|podman]

set -eu
image=${1:?usage: scripts/check-sleep-image.sh IMAGE [docker|podman]}
engine=${2:-docker}
# sgl-project/sglang#40821 as it stands on sglang-miles: the test of the flush order
commit=9a459031679238b053feb1be78d86eb3d06f2295
test=test/registered/unit/managers/test_release_memory_flush_order.py
sha256=b77153e51fca71336f2830b946576e4be1411ec6f7b859d09ed2c926a464cdbb

dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
curl -fsSL "https://raw.githubusercontent.com/sgl-project/sglang/$commit/$test" \
  -o "$dir/test_release_memory_flush_order.py"
echo "$sha256  $dir/test_release_memory_flush_order.py" | sha256sum -c --quiet -

if "$engine" run --rm --network none -v "$dir:/check:ro" -w /check --entrypoint python3 "$image" \
  -m unittest -v test_release_memory_flush_order; then
  echo "$image: the memory saver flushes before it releases; a card may sleep its models"
else
  echo "$image: the memory saver releases before it flushes, or the test did not run; keep \"sleep\": \"stop\"" >&2
  exit 1
fi
