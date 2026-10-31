{
  description = "Cockpit NVIDIA GPU page";

  inputs.nixpkgs.url = "https://flakehub.com/f/NixOS/nixpkgs/0.1";

  outputs = { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
      package = pkgs.callPackage ./nix/package.nix { };
    in {
      packages.${system}.default = package;
      checks.${system}.package = package;

      apps.${system}.setup-pcp = {
        type = "app";
        program = "${pkgs.writeShellScript "cockpit-nvidia-setup-pcp" ''
          exec /usr/bin/sudo ${package}/bin/cockpit-nvidia-setup-pcp "$@"
        ''}";
      };

      homeManagerModules.default = { config, lib, pkgs, ... }:
        let
          cfg = config.programs.cockpit-nvidia;
          cockpitNvidia = pkgs.callPackage ./nix/package.nix { };
        in {
          options.programs.cockpit-nvidia.enable = lib.mkEnableOption "the Cockpit NVIDIA GPU page";
          config = lib.mkIf cfg.enable {
            xdg.dataFile."cockpit/cockpit-nvidia".source = "${cockpitNvidia}/share/cockpit/cockpit-nvidia";
          };
        };
    };
}
