# Terminal demo for the README, on the sample repo from scripts/demo.ts.
# Run from the repo root: vhs scripts/demo.tape
Output docs/demo.gif
Output docs/demo.mp4

Set Shell bash
Set Theme "Catppuccin Mocha"
Set FontSize 19
Set Width 1240
Set Height 720
Set Padding 28
Set TypingSpeed 55ms
Set WindowBar Colorful
Set WindowBarSize 36

Hide
Type `export PS1='\[\e[33m\]~/code/checkout\[\e[0m\] $ ' D=$(mktemp -d) R=$PWD && node scripts/demo.ts $D && npx() { if [ "$1" = potemkin-cli ]; then shift; node $R/src/cli.ts "$@"; else command npx "$@"; fi; } && cd $D/checkout && clear`
Enter
Sleep 1s
Show

Sleep 500ms
Type "npx vitest run | tail -4"
Sleep 300ms
Enter
Sleep 3s

Type "npx potemkin-cli"
Sleep 400ms
Enter
Sleep 9s
