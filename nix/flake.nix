{
  description = "Pro Darwin system flake";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    nix-darwin.url = "github:nix-darwin/nix-darwin";
    nix-darwin.inputs.nixpkgs.follows = "nixpkgs";
    nix-homebrew.url = "github:zhaofengli/nix-homebrew";
    nix-homebrew.inputs.brew-src.follows = "brew-src";

    brew-src = {
      url = "github:Homebrew/brew";
      flake = false;
    };
  };

  outputs =
    inputs@{
      self,
      nix-darwin,
      nixpkgs,
      nix-homebrew,
      ...
    }:
    let
      configuration = { pkgs, ... }: {
        nixpkgs.config.allowUnfree = true;

        # List packages installed in system profile. To search by name, run:
        # $ nix-env -qaP | grep wget
        environment.systemPackages = [
          #pkgs._1password-gui # broken right now
          pkgs.age
          pkgs.alacritty
          pkgs.colima
          pkgs.delve
          pkgs.discord
          pkgs.esphome
          pkgs.fd
          pkgs.ffmpeg
          pkgs.gh
          pkgs.ghostty-bin
          pkgs.go
          pkgs.go-migrate
          pkgs.golangci-lint
          pkgs.goreleaser
          pkgs.jq
          pkgs.just
          pkgs.k6
          pkgs.lazygit
          pkgs.libwebp
          pkgs.neovim
          pkgs.nodejs_24
          pkgs.nph
          #pkgs.obsidian
          pkgs.odin
          #pkgs.ollama
          pkgs.pnpm
          pkgs.python313
          pkgs.python313Packages.pip
          pkgs.ripgrep
          #pkgs.spotify
          pkgs.shellcheck
          pkgs.sqlc
          pkgs.sqlite
          pkgs.sqlitebrowser
          pkgs.starship
          pkgs.tailwindcss_4
          pkgs.tea
          #pkgs.tmux
          pkgs.tree
          pkgs.tree-sitter
          pkgs.turso-cli
          pkgs.uv
          pkgs.wget
          pkgs.zig
        ];

        fonts.packages = [ pkgs.monaspace ];

        homebrew = {
          enable = true;
          taps = [ "piszmog/tools" ];
          brews = [
            "cliclick"
            "nim"
            "piszmog/tools/gtpm"
            "piszmog/tools/lopper"
          ];
          casks = [
            "anomalyco/tap/hex"
            "firefox"
            "orbstack"
            "orion"
            "pallotron-yubiswitch"
            "scroll-reverser"
            "via"
          ];
          greedyCasks = true;
          onActivation.cleanup = "zap";
          onActivation.autoUpdate = true;
          onActivation.upgrade = true;
        };

        system.primaryUser = "randell";

        system.defaults = {
          dock.autohide = true;
          dock.persistent-apps = [
            "/Applications/Brave Browser.app"
            "/Applications/Nix Apps/Ghostty.app"
          ];
          finder.FXPreferredViewStyle = "clmv";
          loginwindow.GuestEnabled = false;
          NSGlobalDomain.AppleICUForce24HourTime = true;
          NSGlobalDomain.AppleInterfaceStyle = "Dark";
        };

        # nix.package = pkgs.nix;

        # Necessary for using flakes on this system.
        nix.settings.experimental-features = "nix-command flakes";

        # Allow the primary user to override daemon settings without sudo.
        nix.settings.trusted-users = [ "randell" ];

        # Keep the switch clonable from a git worktree without warnings.
        nix.settings.warn-dirty = false;

        # Store maintenance.
        nix.gc.automatic = true;
        nix.gc.options = "--delete-older-than 30d";
        nix.optimise.automatic = true;

        # Create /etc/zshrc that loads the nix-darwin environment.
        #programs.zsh.enable = true;  # default shell on catalina
        programs.fish.enable = true;

        # Set Git commit hash for darwin-version.
        system.configurationRevision = self.rev or self.dirtyRev or null;

        # Used for backwards compatibility, please read the changelog before changing.
        # $ darwin-rebuild changelog
        system.stateVersion = 7;

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
              enable = true;
              enableRosetta = true;
              user = "randell";
              trust.taps = [
                "piszmog/tools"
                "anomalyco/tap"
              ];
            };
          }
        ];
      };

      formatter.aarch64-darwin = nixpkgs.legacyPackages.aarch64-darwin.nixfmt;
    };
}
