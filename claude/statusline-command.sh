#!/usr/bin/env bash
# Claude Code status line — mirrors Starship prompt style
# Shows: directory (truncated) | git branch + status | context usage

set -euo pipefail

input=$(cat)

# Directory: truncate to last 3 segments like Starship (truncation_length = 3)
cwd=$(echo "$input" | jq -r '.workspace.current_dir')
home="$HOME"
# Replace home prefix with ~
if [[ "$cwd" == "$home" ]]; then
  display_dir="~"
elif [[ "$cwd" == "$home/"* ]]; then
  display_dir="~/${cwd#"$home"/}"
else
  display_dir="$cwd"
fi
# Truncate to 3 path segments
IFS='/' read -ra parts <<< "$display_dir"
num=${#parts[@]}
if (( num > 3 )); then
  # Keep first segment (~ or root) + last 2
  if [[ "${parts[0]}" == "~" ]]; then
    display_dir="~/.../$(IFS='/'; echo "${parts[*]:num-2:2}")"
  else
    display_dir=".../${parts[num-2]}/${parts[num-1]}"
  fi
fi

# Git branch and status (skip optional locks)
git_info=""
if git -C "$cwd" rev-parse --is-inside-work-tree &>/dev/null; then
  branch=$(git -C "$cwd" --no-optional-locks branch --show-current 2>/dev/null || true)
  if [[ -n "$branch" ]]; then
    # Check for uncommitted changes
    status_flags=""
    if [[ -n $(git -C "$cwd" --no-optional-locks status --porcelain 2>/dev/null) ]]; then
      status_flags=" !"
    fi
    git_info=" $(printf '\ue0a0') ${branch}${status_flags}"
  fi
fi

# Model
model=""
model_name=$(echo "$input" | jq -r '.model.display_name // empty')
if [[ -n "$model_name" ]]; then
  model=" | ${model_name}"
fi

# Context window usage
ctx=""
used=$(echo "$input" | jq -r '.context_window.used_percentage // empty')
if [[ -n "$used" ]]; then
  ctx=" | ctx:${used}%"
fi

printf "%s%s%s%s" "$display_dir" "$git_info" "$model" "$ctx"