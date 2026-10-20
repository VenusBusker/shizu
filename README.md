# Shizu

A minimalist desktop notepad where letters aren't locked to lines. 

You can write normally, but you can also tear words or individual letters apart, convert them into vector objects, deform/scale them, and scatter them across the page (or tuck them behind text).

---

I am not a programmer and I don't know how to code. 

I just wanted a very specific kind of notebook for visual writing, concrete poetry, and zine-making—something that doesn't force me into the rigid grid of standard word processors, but also isn't as bloated as Illustrator or Figma. 

Because I couldn't find an existing tool that does this with a clean text-first flow, I directed AI models to build this prototype step by step. 

It works, it exports clean PNG and SVG files, and it saves documents in its own `.shizu` state format. But the codebase could definitely use the eyes and hands of real developers.

---

### Core Mechanics
- **Simple Writing Canvas:** Inter, Georgia, Noto Sans JP, and Cedarville Cursive. Ruled notebook mode with adjustable line spacing.
- **Selective Vectorization:** Select any word, sentence, or single letter and convert it into a vector object via the toolbar or right-click.
- **Deform & Scale:** Pull handles to stretch, scale, and manipulate letterforms.
- **Layering (Z-Index):** Send modified glyphs behind or in front of regular typed text.
- **Selective Extraction:** Pull a single letter out of a word without exploding the rest of the word.
- **Grouping ("Kenetle"):** Marquee-select scattered letters and lock them into a single compound object.
- **Revert to Text:** Right-click any vectorized glyph/word to convert it back into regular editable text.
- **Export:** High-resolution PNG and lossless vector SVG.

---

### Contributing
Since this was pieced together through AI prompting, there are certainly quirks, edge cases, and architectural cleanup waiting to be done. 

If you like typography, experimental text editors, or the idea of concrete poetry on a digital canvas, feel free to fork, open an issue, or submit a pull request.