Dependency and redistribution notes

Mediabunny 1.60.0

License: MPL-2.0.
Upstream: https://github.com/Vanilagy/mediabunny
This package imports the published library through its public API and does not modify Mediabunny source. Distributions must retain its license and notices. Any future modifications to MPL-covered files must be made available under MPL-2.0.

mpg123-decoder 1.0.3

JavaScript wrapper license: MIT.
Upstream: https://github.com/eshaz/wasm-audio-decoders/tree/main/src/mpg123-decoder
Embedded mpg123 license: LGPL-2.1.
mpg123 source: https://www.mpg123.de/download.shtml

The decoder is kept as an unmodified, independently replaceable npm/WASM dependency behind src/mp2.ts. It is not copied, statically merged into this package's source, or modified here. A product distribution must retain the MIT and LGPL-2.1 texts and copyright notices, publish the corresponding source/version information for the embedded mpg123 build, and preserve the user's practical ability to replace/relink the decoder boundary. The parent integration owner must include those texts and source links in the aggregate product notices/SBOM.
