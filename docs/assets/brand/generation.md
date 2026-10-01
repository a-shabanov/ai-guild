# Brand assets

Generated with the built-in `image_gen` tool in Codex. Mode: generate for the two initial full-colour concepts, edit for the selected blue icon using the gateway and original-blue references, and edit for notification experiments. No alternate provider was used.

The selected `guild-blue.png` appears in the README and supplies the iOS/PWA app icons. A human head and AI sparkle sit above two opposing figures; the orange centre is their shared result. `open-gateway.png` and `relay-knot.png` are earlier concepts. Notification experiments were rejected because their edges were rough; the existing neutral check badge remains. The app-icon sizes are engineering resizes of the selected master using macOS `sips`.

## Exact generation requests

### Request 1

```javascript
// @exec: {"yield_time_ms": 120000, "max_output_tokens": 1000}
const p=tools.image_gen__imagegen({prompt:"Use case: logo-brand. Asset type: a single production-quality square app icon master for an open source workspace where humans assign work to AI coding agents, agents record evidence and costs, and humans review the result. Primary request: create a distinctive editorial-tech mark expressing handoff and a durable record of work. Design direction A: three broad interlocking ribbon paths form a compact geometric relay knot with a subtle upward motion; orange/coral accent and warm ivory on an inky midnight-blue full-bleed square background. Flat vector-like precision with just a restrained tactile surface, not glossy 3D. One centered mark occupying 60% of the square, crisp enough at 32 pixels, generous safe margin. No rounded outer corners baked into the image, no border, no mockup, no wordmark, no letters, no checkmark, no robot, no sparkle, no watermark. This is the complete icon image, not a presentation sheet. Square composition.",transparent_background:false});
await yield_control();
const r=await p;store("iconA",r);generatedImage(r);
text({kind:"iconA",keys:typeof r==="object"?Object.keys(r):[],hint:r?.output_hint});

```

### Request 2

```javascript
// @exec: {"yield_time_ms": 120000, "max_output_tokens": 1000}
const p=tools.image_gen__imagegen({prompt:"Use case: logo-brand. Asset type: square app icon master for an open source task and work-evidence tracker used by humans and AI coding agents. Primary request: a memorable minimal brand symbol that suggests a work log with a handoff. Direction B: two bold offset folded strips forming a distinctive architectural monogram-like open gateway, with one small separate square node passing between them. The shape should feel like an open book crossed with a relay, not a literal letter and not a checkmark. Warm ivory full-bleed square background, deep navy main shape and vermilion orange single node. Contemporary Swiss editorial simplicity; truly flat geometry, no texture, no shadow or gradients. One centered symbol, about 56% of the frame with generous margin for app icon safe area. Crisp at 32px. No text, no wordmark, no letters, no robot, no sparkles, no mockup, no sheet of multiple variants, no watermark. Square image with sharp full-bleed outer corners.",transparent_background:false});
await yield_control();const r=await p;store("iconB",r);generatedImage(r);text({kind:"iconB",hint:r?.output_hint});

```

### Request 3

```javascript
// @exec: {"yield_time_ms": 120000, "max_output_tokens": 1000}
const p=tools.image_gen__imagegen({prompt:"Use case: background-extraction. Edit the referenced open-gateway brand icon into a notification badge asset. Preserve the exact two offset gateway strips and the small central square node as a single solid-white silhouette, with clean flat edges. Remove the ivory background completely, transparent background with actual alpha. No navy, orange, gradients, texture or shadow. The three white shapes have the same arrangement as the reference. Center the symbol within a square, occupying 70% of its width, generous margin. This is a monochrome app notification glyph for AI Guild, not an illustration or mockup. No text, no border, no rounded background tile.",referenced_image_paths:["/Users/shabanov/Projects/AI-tracker/docs/assets/brand/open-gateway.png"],transparent_background:true});
await yield_control();const r=await p;store("badge",r);generatedImage(r);text({kind:"badge",hint:r?.output_hint});

```

### Request 4

```javascript
// @exec: {"yield_time_ms": 120000, "max_output_tokens": 1000}
const r=await tools.image_gen__imagegen({prompt:"Create a perfectly clean monochrome notification glyph, transparent PNG background. Three simple geometric shapes only: two upright parallel offset doorway bars with rounded ends, and one small square in their centre. Match the attached reference's gateway symbol. All three shapes must be pure solid white, with smooth clean edges. No texture, no speckles, no distress, no outlines, no gradients, no shadows, no letters. Centre the compact symbol in a square canvas with 20% transparent margins. This is a tiny Android/PWA notification icon, so clarity is essential.",referenced_image_paths:["/Users/shabanov/Projects/AI-tracker/docs/assets/brand/open-gateway.png"],transparent_background:true}); store("cleanBadge",r);generatedImage(r);

```

### Request 5

```javascript
// @exec: {"yield_time_ms": 120000, "max_output_tokens": 1000}
const r=await tools.image_gen__imagegen({prompt:"Edit the FIRST reference into a polished AI Guild app icon, using the SECOND reference only for its original saturated blue gradient and the small four-point AI sparkle. Square full-bleed background, bright cobalt blue at top-left blending smoothly into deep royal blue bottom-right. No transparency and no baked rounded outer corners. Preserve the first reference's distinctive two opposing gateway figures and the small orange collaborative product between them. Change the two navy figures to crisp ivory-white so they read clearly on blue. Make the left figure subtly human: a small round head integrated above its broad geometric shoulder/torso. Make the right figure subtly an AI agent: a small four-point sparkle as its head above the opposing geometric shoulder/torso. The two face toward their shared orange rounded diamond/card in the centre, symbolising the finished product made together. Keep the gateway geometry recognisable, balanced and minimalist; exactly two figures, exactly one orange central result and one AI sparkle. Use flat, precise geometric foreground edges, no texture, no distressed edges, no letters, no text, no extra symbols, no 3D effects, no cast shadows. Generous safe margins so it reads well as a 32px favicon and within a circular app mask. Premium friendly technical brand, human-agent collaboration.",referenced_image_paths:["/Users/shabanov/Projects/AI-tracker/docs/assets/brand/open-gateway.png","/private/tmp/ai-guild-original-blue.png"],transparent_background:false});store("guildBlue",r);generatedImage(r);

```
