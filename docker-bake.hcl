group "default" {
  targets = ["release"]
}

target "release-base" {
  context    = "."
  dockerfile = "Dockerfile"
  target     = "runtime"
}

target "release" {
  inherits  = ["release-base"]
  platforms = ["linux/amd64", "linux/arm64"]
  attest = [
    "type=provenance,mode=max,version=v1",
    "type=sbom,generator=docker.io/docker/buildkit-syft-scanner@sha256:ae4f3b554449e7e25548e7d8ccc029d17357348e30c6e3df01b92bc93654d6a9",
  ]
}

target "release-local" {
  inherits = ["release-base"]
}
