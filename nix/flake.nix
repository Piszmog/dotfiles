{
  description = "Pro Darwin system flake";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    nix-darwin.url = "github:LnL7/nix-darwin";
    nix-darwin.inputs.nixpkgs.follows = "nixpkgs";
    nix-homebrew.url = "github:zhaofengli-wip/nix-homebrew";

    homebrew-core = {
      url = "github:homebrew/homebrew-core";
      flake = false;
    };
    homebrew-cask = {
      url = "github:homebrew/homebrew-cask";
      flake = false;
    };
  };

  outputs = inputs@{ self, nix-darwin, nixpkgs, nix-homebrew, ... }:
  let
    configuration = { pkgs, config, ... }: {
      nixpkgs.config.allowUnfree = true;

      # List packages installed in system profile. To search by name, run:
      # $ nix-env -qaP | grep wget
      environment.systemPackages =
        [ 
          #pkgs._1password-gui # broken right now
          pkgs.alacritty
          pkgs.delve
          pkgs.discord
          pkgs.fd
          pkgs.ffmpeg
	        pkgs.fish
          pkgs.gh
          #pkgs.ghostty
          pkgs.go
          pkgs.go-migrate
          pkgs.golangci-lint
          pkgs.goreleaser
          pkgs.jq
          pkgs.k6
          pkgs.lazydocker
          pkgs.lazygit
          pkgs.monaspace
          pkgs.mkalias
          pkgs.neovim
          pkgs.nph
          pkgs.nodejs_24
          #pkgs.obsidian
          pkgs.ollama
          #pkgs.opencode
          pkgs.python313
          pkgs.python313Packages.pip
          pkgs.ripgrep
          pkgs.SDL2
          pkgs.SDL2.dev
          pkgs.SDL2_ttf
          pkgs.spotify
          pkgs.sqlc
          pkgs.sqlite
          pkgs.starship
          pkgs.tmux
          pkgs.tree
          pkgs.tree-sitter
          pkgs.turso-cli
          pkgs.wget
          pkgs.zig
        ];

      homebrew = {
        enable = true;
        taps = [
          "piszmog/tools"
          "sst/tap"
        ];
        brews = [
          "piszmog/tools/gtpm"
          "piszmog/tools/lopper"
          "nim"
          "sst/tap/opencode"
        ];
        casks = [
          "docker"
          "firefox"
          "font-monaspace-nerd-font"
          "ghostty"
          "orion"
          "pallotron-yubiswitch"
          "scroll-reverser"
          "via"
          "zen-browser"
        ];
        onActivation.cleanup = "zap";
        onActivation.autoUpdate = true;
        onActivation.upgrade = true;
      };

      system.primaryUser = "randell";
      system.activationScripts.applications.text = let
        env = pkgs.buildEnv {
          name = "system-applications";
          paths = config.environment.systemPackages;
          pathsToLink = "/Applications";
        };
      in
        pkgs.lib.mkForce ''
        # Set up applications.
        echo "setting up /Applications..." >&2
        rm -rf /Applications/Nix\ Apps
        mkdir -p /Applications/Nix\ Apps
        find ${env}/Applications -maxdepth 1 -type l -exec readlink '{}' + |
        while read -r src; do
          app_name=$(basename "$src")
          echo "copying $src" >&2
          ${pkgs.mkalias}/bin/mkalias "$src" "/Applications/Nix Apps/$app_name"
        done
      '';

      system.defaults = {
        dock.autohide = true;
        dock.persistent-apps = [
          "/Applications/Orion.app"
          "/Applications/Ghostty.app"
        ];
        finder.FXPreferredViewStyle = "clmv";
        loginwindow.GuestEnabled = false;
        NSGlobalDomain.AppleICUForce24HourTime = true;
        NSGlobalDomain.AppleInterfaceStyle = "Dark";
      };

      # nix.package = pkgs.nix;

      # Necessary for using flakes on this system.
      nix.settings.experimental-features = "nix-command flakes";

      # Create /etc/zshrc that loads the nix-darwin environment.
      #programs.zsh.enable = true;  # default shell on catalina
      programs.fish.enable = true;

      # Set Git commit hash for darwin-version.
      system.configurationRevision = self.rev or self.dirtyRev or null;

      # Used for backwards compatibility, please read the changelog before changing.
      # $ darwin-rebuild changelog
      system.stateVersion = 5;

      # The platform the configuration will be used on.
      nixpkgs.hostPlatform = "aarch64-darwin";
    };
  in
  {
    # Build darwin flake using:
    # $ darwin-rebuild build --flake .#pro
    darwinConfigurations."pro" = nix-darwin.lib.darwinSystem {
      modules = [
        configuration
        nix-homebrew.darwinModules.nix-homebrew
        {
          nix-homebrew = {
            # Install Homebrew under the default prefix
            enable = true;

            # Apple Silicon Only: Also install Homebrew under the default Intel prefix for Rosetta 2
            enableRosetta = true;

            # User owning the Homebrew prefix
            user = "randell";

            # Automatically migrate existing Homebrew installations
            autoMigrate = true;
          };
        }
      ];
    };

    # Expose the package set, including overlays, for convenience.
    darwinPackages = self.darwinConfigurations."pro".pkgs;
  };
}
