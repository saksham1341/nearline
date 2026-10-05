---
version: 1
slug: "public-index-html"
primary_target: "public/index.html"
related_targets: ["public/styles.css","apps/web/render-post.ts","apps/web/render-feed.ts","apps/web/render-thread.ts","public/how-it-works.html"]
---

# Nearline web client

Scope: the whole browser client (passkey gate, location gate, feed shell with Latest and Trending, thread view, composers, private-filter sheet) and the public /how-it-works page. Visitor mode: Operate (the explainer page is Read).

Audience and job: people physically near each other, mostly on phones outdoors, finding out "what's happening here" and joining in. Threads and branches fade 15 minutes after their last activity. The owner may later switch to a familiar timeline look, so the world lives in CSS tokens and one stylesheet section; markup and render code stay world-neutral.

## Direction contract

THESIS: Nearline is the local noticeboard: everything people pin here is a flyer, and every flyer is being torn down minute by minute unless someone tends it. It refuses the category default of a grey timeline of hairline-separated rows with one accent colour.

OWN-WORLD: Flat cork ground, black photocopy ink, flyers on flat photocopy-stock paper (canary, fluoro pink, sky, lime, tangerine, lilac, mint, white) chosen by the author's hash, with a pushpin in the paper's deep shade. Archivo set wide and heavy for flyer voices, condensed for tabs, normal width for reading. Shell is the board's black frame. A private filter swaps the cork for green felt. No gradients, no shadows beyond a single paper lift.

STORY: The visitor sees at once that these are notes from the people around them, how far they are listening, which notes are fresh and which are about to come down, and how to pin their own.

FIRST VIEWPORT: Phone: black frame bar with the wordmark, range control (Close / Nearby / Wide) and the room and identity controls; Latest / Trending tabs; then a column of flyers on cork, each with author pin, handle, age, text, reply / repost / like, and a fringe of tear-off tabs along the bottom; the composer pinned at the bottom as a blank flyer. Desktop: black frame sidebar with the controls, the board in the centre, the open thread pinned in a right column at 1280 px and wider.

FORM: Community noticeboard with tear-off flyers, candidate 3 of 7 on the ordered list (wheatpaste poster wall, sidewalk chalk, community noticeboard, stadium scoreboard, weather radar, split-flap departure board, photocopied zine). Seed key 7f85a0df. Signature move: the tear-off fringe. Every post carries one tab per minute of life left (15 at most); a tab tears off and drops each quiet minute, and all grow back when someone replies, likes or reposts. Replies carry their own branch's fringe. Raises: from labanotation, length encodes exact duration, so the tab count is the remaining minutes, not a decoration; from the centre-rail edition, one hairline weight for every rule and perforation; from the bitmap specimen, one display family at strict size steps; from the zoo guide map, flat unmodulated colour; from the Crouwel grid, every size on a 4 px grid; from the split-flap board, one moving part per change (a fresh flyer pins in, a tab tears).

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
