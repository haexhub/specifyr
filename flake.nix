{
  description = "Specifyr specifyr — multi-agent orchestration platform";

  inputs = {
    nixpkgs.url      = "github:NixOS/nixpkgs/nixos-unstable";
    hermes-agent.url = "github:NousResearch/hermes-agent";
    # Share nixpkgs between specifyr and hermes-agent to avoid duplicate
    # store paths and halve first-build download time.
    hermes-agent.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = { self, nixpkgs, hermes-agent, ... }:
    let
      systems     = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems f;
    in {
      # Dev shell for working on specifyr itself.
      devShells = forAllSystems (system:
        let pkgs = nixpkgs.legacyPackages.${system};
        in {
          default = pkgs.mkShell {
            packages = with pkgs; [ nodejs_22 pnpm nix ];
          };
        }
      );

      # Agent container images are built dynamically at company-start time
      # by src/runners/agent-image-builder.js using:
      #
      #   nix build --impure --expr '
      #     let
      #       flake  = builtins.getFlake "path:<projectRoot>";
      #       pkgs   = flake.inputs.nixpkgs.legacyPackages.<system>;
      #       hermes = flake.inputs.hermes-agent.packages.<system>.default;
      #     in pkgs.dockerTools.buildLayeredImage {
      #       name     = "specifyr-agent";
      #       tag      = "<content-hash>";
      #       contents = with pkgs; [ hermes <packages...> ];
      #     }
      #   '
      #
      # The flake.lock pins exact revisions of nixpkgs and hermes-agent,
      # ensuring every team member builds the identical image.
      # Run `nix flake update` to advance the pins.
    };
}
