# Assets Directory

## Icons Needed

To complete the desktop app, you need to add icon files:

### Required Files:
- `icon.png` - 256x256px app icon
- `tray-icon.png` - 16x16px or 32x32px system tray icon
- `icon.ico` - Windows icon file (for installer)

### How to Create Icons:

1. **Use the provided `icon.svg`** as a starting point
2. Convert to PNG using any tool:
   - Online: https://svgtopng.com/
   - Photoshop/GIMP/Figma
   - Command line: `convert icon.svg -resize 256x256 icon.png`

3. **For Windows .ico file:**
   - Use online converter: https://convertio.co/png-ico/
   - Or use: https://www.icoconverter.com/

### Temporary Solution:

For now, the app will run without icons (Electron will use default icons).
The functionality works perfectly - icons are just cosmetic.

### Quick Icon Generation:

If you have ImageMagick installed:
```bash
convert icon.svg -resize 256x256 icon.png
convert icon.svg -resize 32x32 tray-icon.png
convert icon.png icon.ico
```

Or use an online tool to convert the SVG to PNG/ICO.


