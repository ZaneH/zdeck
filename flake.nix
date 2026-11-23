{
  description = "Deck native Tauri shell development environment";

  # Pinned to the same nixpkgs revision as ~/nix-config for store consistency.
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/c043004d1c6985732bcc1cbc5a9c9aecbbb4e0f0";

  outputs =
    { self, nixpkgs }:
    let
      # Only x86_64-linux is tested. Other targets are future validation.
      systems = [ "x86_64-linux" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      devShells = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          nativeLibs = with pkgs; [
            webkitgtk_4_1
            gtk3
            glib
            libsoup_3
            openssl
            xz
            librsvg
          ];
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.cargo
              pkgs.rustc
              pkgs.rustfmt
              pkgs.pkg-config
              pkgs.nodejs_22
              pkgs.patchelf
              # Session-service tools for the native system actions.
              pkgs.playerctl
              pkgs.wireplumber
            ] ++ nativeLibs;

            # The npm @tauri-apps/cli native binding dlopens liblzma.so.5, which
            # is not on the default loader path inside a Nix shell.
            shellHook = ''
              export LD_LIBRARY_PATH="${pkgs.xz.out}/lib''${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
            '';
          };
        }
      );
    };
}
