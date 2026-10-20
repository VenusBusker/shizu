# Shizu

A minimalist desktop notepad where letters aren't locked to lines. 

You can write normally, but you can also tear words or individual letters apart, convert them into vector objects, scale them and scatter them across the page.

<img width="1920" height="1010" alt="Ekran Görüntüsü 2026-10-20 05-12-31" src="https://github.com/user-attachments/assets/4805c649-2273-416f-ba41-834d88feddbb" />
<img width="832" height="902" alt="Ekran Görüntüsü 2026-10-20 04-12-49" src="https://github.com/user-attachments/assets/fa72c74f-ef00-4c8e-935d-834d887b040a" />


---

I am not a programmer and I don't know how to code. 

I just wanted a very specific kind of notebook for visual writing but also isn't as bloated as Illustrator or Figma. 

Since I couldn't find an existing tool that does this with a clean text-first flow, I directed AI models to build this prototype step by step. 

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
- **Export:** High-resolution PNG (nah png sucks actually) and lossless vector SVG.

- <img width="692" height="388" alt="Ekran Kaydı 2026-10-20 04-01-55" src="https://github.com/user-attachments/assets/bcfc36a0-7440-4a44-8ff4-bd11555ed542" />


---

### Contributing
Since this was pieced together through AI prompting, there are certainly quirks, edge cases, and architectural cleanup waiting to be done. 

If you like typography, experimental text editors, or the idea of concrete poetry on a digital canvas, feel free to fork, open an issue, or submit a pull request.
