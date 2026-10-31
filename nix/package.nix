{ buildNpmPackage, lib }:

buildNpmPackage {
  pname = "cockpit-nvidia";
  version = (builtins.fromJSON (builtins.readFile ../package.json)).version;
  src = ../.;

  npmDepsHash = "sha256-qrLRJKzV1/r3hE8Y1igJwQIZrQEBxzkrieRdJRxrnkQ=";
  npmBuildScript = "build";

  installPhase = ''
    runHook preInstall
    install -d "$out/share/cockpit/cockpit-nvidia" "$out/bin" "$out/pcp"
    cp -r dist/. "$out/share/cockpit/cockpit-nvidia/"
    install -m 755 scripts/install-pcp.sh "$out/bin/cockpit-nvidia-setup-pcp"
    install -m 644 pcp/core "$out/pcp/core"
    runHook postInstall
  '';

  meta = {
    description = "NVIDIA GPU monitoring page for Cockpit";
    homepage = "https://github.com/i-am-karan-singh/cockpit-nvidia";
    platforms = lib.platforms.linux;
  };
}
