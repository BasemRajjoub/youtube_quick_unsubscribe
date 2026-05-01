# YouTube Quick Unsubscribe

A [Violentmonkey](https://violentmonkey.github.io/) userscript that adds an **Unsubscribe** button under every video card on your YouTube feed.

## Install

1. Install [Violentmonkey](https://violentmonkey.github.io/) for your browser.
2. Create a new script in Violentmonkey and paste in [`youtube-quick-unsubscribe.user.js`](youtube-quick-unsubscribe.user.js).

## How it works

Clicking **Unsubscribe** opens a small popup of the channel page, automatically clicks through the unsubscribe flow, then closes the popup. A toast notification confirms each step.

> Allow popups for `youtube.com` in your browser for the script to work.

## Features

- Unsubscribe button beneath every video card on your feed
- Works with YouTube's new lockup layout
- Blocks images/videos in the popup for a faster flow
- No external dependencies
