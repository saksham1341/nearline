---
version: 1
slug: "public-index-html"
primary_target: "public/index.html"
related_targets: ["public/styles.css","apps/web/main.ts"]
---

# Nearline web client

Scope: the whole browser client (passkey gate, location gate, live chat shell, private-filter sheet). Visitor mode: Operate.

Audience and job: people physically near each other, mostly on phones outdoors or in transit, who want to read the local line and drop a message within seconds. Constraints: live-only delivery, anonymous 8-hex author labels, three listening ranges, optional private filter. No direction was given by the owner; the assigned direction was built unattended.

## Direction contract

THESIS: Nearline is the ground you are standing on. The chat is painted onto asphalt in road-marking grammar; range is read the way drivers read lane dashes. It refuses the category default of a grey dark-mode chat with one neon accent and bubble rows.

OWN-WORLD: Warm asphalt ground with faint aggregate, thermoplastic white paint for ink, road yellow reserved for restriction (the private filter, as box-junction hatching), signal green only for "live". Barlow and Barlow Condensed (descended from highway signage); elongated condensed caps for painted words; author labels in mono beside a road-stud chip whose colour comes from the author hash. No cards, no bubbles, no shadows; every rule is a painted stroke from one stroke scale.

STORY: The visitor sees at once that this is a local live line, how far they are listening, whether they are public or inside a private filter, and whether they are connected; then they read and type.

FIRST VIEWPORT: Phone: header with painted NEARLINE wordmark left, identity and view controls right; a range strip below it: three segments Close / Nearby / Wide with plain-language reach, sitting on a dashed lane line; transcript fills the middle; composer pinned at the bottom behind a solid stop line. Desktop: left sidebar (wordmark, range, view, identity, connection) and the conversation column. Gate screens: huge painted wordmark in perspective on the ground, headline, passkey actions.

FORM: Road and pedestrian-crossing markings on asphalt, candidate 7 of 7 on the ordered list (transit wayfinding, OS topographic map, lamp-post flyers, enamel street plates, festival zone map, weather-radar bands, road markings). Seed key cf2b5c1b. Signature move: the lane line's dash length encodes range (short dashes for Close, long for Wide, as on slow versus fast roads) and repaints when range changes; a private filter repaints it as a yellow box-junction hatch. Raises: from metro tiles, chrome deleted so markings are the only chrome; from the centre-rail edition, one strict stroke scale; from the timetable rack, rank carried by weight, case and reversal across at most four type sizes; from the Saville catalogue, author hashes encoded as a colour stud; from Ikeda, reduced motion holds one still state.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
