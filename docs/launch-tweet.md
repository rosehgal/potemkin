# Launch tweet

Post as one tweet with `docs/card.png` attached (or the 15s demo video), command in the text, repo link in the first reply. No bare links in the main post.

## Main post

Your AI agent says "all tests pass". Cool. Are the tests testing anything?

I built Potemkin. It takes every function your agent just changed, replaces the body with `return undefined`, and runs the tests again.

On a real diff from my own agent: 3 of 6 new functions could be gutted and every test stayed green. The tests called the code and asserted nothing.

Runs locally, no API key, vitest/jest/pytest:

npx potemkin-cli

It also ships as a Claude Code hook that sends the agent back with the list of hollow tests before you ever read the diff.

## First reply

Repo + how it works: https://github.com/rosehgal/potemkin

It's conservative on purpose: a crash, a timeout or a test that already fails never counts as "hollow". It asks the whole suite which tests load the file before it accuses anything.

## Second reply (the card)

`--share` renders this card from your own repo. Post yours. Worst ratio wins.

## Alternative hooks (pick one if the main post feels long)

1. "Green tests" is not the same as "tested". Potemkin guts your agent's functions and reruns the suite. 3 of 6 survived on my last diff.
2. I deleted the body of every function my agent wrote today. The tests passed. npx potemkin-cli
3. Mutation testing, but only the mutant that matters for agent code: "what if this function did nothing at all?"
