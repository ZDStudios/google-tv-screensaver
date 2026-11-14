# google-tv-screensaver

The screensaver page for the Lumen launcher on the Chromecast. Lumen shows
`https://zdstudios.github.io/google-tv-screensaver/` after 35 minutes idle, dimmed.

## How updates reach the TV

1. Push a new `index.html` to `main`.
2. GitHub Pages publishes it. The TV notices within about a minute and reloads.
3. The **Render screensaver video** Action also turns the page into a seamless 60 s
   1080p loop and publishes it to the `screensaver-video` branch (`loop.mp4` + `meta.json`).

## Live page or video?

When the page is too slow for the TV, Lumen plays the rendered video (canvas only) and shows the
page's normal HTML on top of it, live, with the canvas and requestAnimationFrame switched off.
So clocks and countdowns stay correct while the heavy scene comes from the video. No manual work
is needed after a push.


The TV plays the page live, measures its frame rate once per version, and if it's
below 20 fps it crossfades to the rendered video (hardware-decoded, always smooth).
The video is only used when it was rendered from the exact same `index.html` bytes.

A page can choose for itself:

```html
<meta name="lumen-playback" content="live">   <!-- has live data (clocks, countdowns): never use the video -->
<meta name="lumen-playback" content="video">  <!-- heavy and timeless: always use the video -->
```

The video records time as it was when rendered, so clocks/countdowns in it are frozen.
Renders run in UTC; set `TIMEZONE` (e.g. `Australia/Perth`) in the workflow's `env` to change that.
