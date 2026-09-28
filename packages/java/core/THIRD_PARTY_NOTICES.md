# Third-party notices

## JSON Canonicalization Scheme number serializer

The following files are vendored from
[`cyberphone/json-canonicalization`](https://github.com/cyberphone/json-canonicalization)
commit `19d51d7fe467d4706a3ff08adf8a748f29fc21e0`:

- `DoubleCoreSerializer.java`, pristine SHA-256
  `61246c838dbfdf372ca7955768695dffe3ffeabb09a8739dbb1bc2245a7561d7`,
  from
  `https://raw.githubusercontent.com/cyberphone/json-canonicalization/19d51d7fe467d4706a3ff08adf8a748f29fc21e0/java/canonicalizer/src/org/webpki/jcs/DoubleCoreSerializer.java`;
- `NumberToJSON.java`, pristine SHA-256
  `b17555e45aa1c6fdf5924ef02df14b25d8fad1d9c7d81f1e33954e82a4f7a78a`,
  from
  `https://raw.githubusercontent.com/cyberphone/json-canonicalization/19d51d7fe467d4706a3ff08adf8a748f29fc21e0/java/canonicalizer/src/org/webpki/jcs/NumberToJSON.java`;
- upstream `LICENSE`, pristine SHA-256
  `6821faaddedf2d78c95bb6d98b127e9e616097afd2f6bcc34389f000d13ab12d`,
  from
  `https://raw.githubusercontent.com/cyberphone/json-canonicalization/19d51d7fe467d4706a3ff08adf8a748f29fc21e0/LICENSE`.

Copyright 2018 Ulf Adams.

Modifications for ECMAScript / RFC 8785 by Anders Rundgren.

The two Java sources retain their complete upstream headers and bodies. The
only modification is relocation of the package declaration from
`org.webpki.jcs` to
`dev.eightlines.gauntlet.core.json.internal.jcs`. The receipt test reverses
that one relocation and verifies the pristine source hashes byte for byte.

The complete upstream Apache License 2.0 file is included verbatim at
`META-INF/licenses/json-canonicalization-LICENSE` in the built JAR and is also
checked in at `THIRD_PARTY_LICENSES/json-canonicalization-LICENSE`.
