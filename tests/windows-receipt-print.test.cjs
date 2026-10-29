const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const childEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(systemroot|windir|temp|tmp|path|comspec|userprofile|homedrive|homepath|localappdata|appdata|programfiles|programfiles\(x86\)|processor_architecture)$/i.test(key)));

const backend = path.resolve(__dirname, '../windows-receipt-print.ps1');
const temporary = mkdtempSync(path.join(os.tmpdir(), 'yala-graphics-preview-test-'));
const generator = path.join(temporary, 'fixtures.ps1');
writeFileSync(generator, `param([string] $OutputDirectory)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
foreach ($spec in @(@('short',640,400), @('narrow',464,500), @('long',640,8000), @('oversized',2049,1))) {
    $bitmap = New-Object System.Drawing.Bitmap([int]$spec[1], [int]$spec[2])
    try {
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        try {
            $graphics.Clear([System.Drawing.Color]::White)
            $graphics.FillRectangle([System.Drawing.Brushes]::Black, 0, 0, $bitmap.Width, 8)
            $graphics.FillRectangle([System.Drawing.Brushes]::Black, 0, ($bitmap.Height - 8), $bitmap.Width, 8)
            $font = New-Object System.Drawing.Font('Arial',24)
            try {
                $graphics.DrawString('SYNTHETIC RECEIPT 123', $font, [System.Drawing.Brushes]::Black, 20, 20)
                $arabic = [string][char]0x645 + [char]0x631 + [char]0x62D + [char]0x628 + [char]0x627
                $graphics.DrawString($arabic, $font, [System.Drawing.Brushes]::Black, 200, 65)
            } finally { $font.Dispose() }
            for ($y = 120; $y -lt $bitmap.Height - 10; $y += 80) {
                $graphics.FillRectangle([System.Drawing.Brushes]::Black, 30, $y, 40, 20)
            }
        } finally { $graphics.Dispose() }
        $bitmap.Save((Join-Path $OutputDirectory ($spec[0] + '.png')), [System.Drawing.Imaging.ImageFormat]::Png)
    } finally { $bitmap.Dispose() }
}
`, 'utf8');
execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', generator, '-OutputDirectory', temporary], { windowsHide: true, env: childEnvironment, timeout: 30000 });

let sequence = 0;
function runBackend(overrides = {}, { preview = true } = {}) {
    const id = ++sequence;
    const manifest = path.join(temporary, `manifest-${id}.json`);
    const directory = path.join(temporary, `preview-${id}`);
    writeFileSync(manifest, JSON.stringify({ printerName: 'Synthetic queue never used for physical printing', paperWidth: 80,
        jobName: 'Synthetic graphics preview', imagePath: path.join(temporary, 'short.png'), ...overrides }));
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', backend, '-ManifestPath', manifest];
    if (preview) args.push('-PreviewDirectory', directory);
    const child = spawnSync('powershell.exe', args, { encoding: 'utf8', windowsHide: true, env: childEnvironment, timeout: 30000 });
    assert.ifError(child.error);
    assert.equal(child.stderr.trim(), '', 'backend must return sanitized JSON, not private diagnostics');
    const result = JSON.parse(child.stdout.trim());
    return { result, directory, status: child.status };
}

function pixels(directory) {
    const inspect = path.join(temporary, 'inspect.ps1');
    writeFileSync(inspect, `param([string] $Directory)
Add-Type -AssemblyName System.Drawing
$results = @()
foreach ($file in Get-ChildItem -LiteralPath $Directory -Filter '*.png' | Sort-Object Name) {
    $image = New-Object System.Drawing.Bitmap($file.FullName)
    try {
        $dark = 0
        $left = $image.Width
        $right = -1
        $top = $image.Height
        $bottom = -1
        for ($y = 0; $y -lt $image.Height; $y++) {
            for ($x = 0; $x -lt $image.Width; $x++) {
                if ($image.GetPixel($x,$y).R -lt 100) {
                    $dark++
                    $left = [Math]::Min($left,$x)
                    $right = [Math]::Max($right,$x)
                    $top = [Math]::Min($top,$y)
                    $bottom = [Math]::Max($bottom,$y)
                }
            }
        }
        $results += [pscustomobject]@{width=$image.Width;height=$image.Height;dark=$dark;left=$left;right=$right;top=$top;bottom=$bottom}
    } finally { $image.Dispose() }
}
ConvertTo-Json -InputObject @($results) -Compress
`, 'utf8');
    return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', inspect, '-Directory', directory], { encoding: 'utf8', windowsHide: true, env: childEnvironment, timeout: 60000 }));
}

test.after(() => {
    assert.ok(path.resolve(temporary).startsWith(path.resolve(os.tmpdir()) + path.sep));
    rmSync(temporary, { recursive: true, force: true });
});

test('Windows preview renders a bounded 80 mm bitmap without submitting a print job', () => {
    const { result, directory, status } = runBackend();
    assert.equal(status, 0);
    assert.equal(result.success, true);
    assert.equal(result.preview, true);
    assert.equal(result.submitted, false);
    assert.equal(result.pages, 1);
    assert.equal(result.printableWidthMm, 72);
    assert.equal(result.horizontalOffsetMm, 0);
    const [page] = pixels(directory);
    assert.ok(page.width >= 600 && page.width <= 650);
    assert.ok(page.dark > 1000);
    assert.ok(page.right - page.left > 500, 'both width and bitmap scaling are preserved');
    assert.ok(page.bottom - page.top >= 300, 'bitmap height is preserved without clipping');
});

test('58 mm preview retains physical scaling and contains visible content', () => {
    const { result, directory, status } = runBackend({ paperWidth: 58, imagePath: path.join(temporary, 'narrow.png') });
    assert.equal(status, 0);
    assert.equal(result.pages, 1);
    assert.equal(result.submitted, false);
    assert.equal(result.printableWidthMm, 48);
    assert.equal(result.horizontalOffsetMm, 0);
    const [page] = pixels(directory);
    assert.ok(page.width >= 430 && page.width <= 480);
    assert.ok(page.dark > 1000);
});

test('long receipts split into a small bounded number of nonempty preview pages', () => {
    const { result, directory, status } = runBackend({ imagePath: path.join(temporary, 'long.png') });
    assert.equal(status, 0);
    assert.ok(result.pages >= 3 && result.pages <= 5);
    assert.equal(result.submitted, false);
    assert.equal(readdirSync(directory).filter(name => name.endsWith('.png')).length, result.pages);
    const pages = pixels(directory);
    for (const page of pages) assert.ok(page.dark > 1000, 'every generated page contains receipt content');
    assert.ok(pages.at(-1).right - pages.at(-1).left > 500, 'final full-width marker is retained on the last page');
    for (const page of pages.slice(1)) assert.ok(page.top > 0, 'continuation pages start within whitespace instead of cutting content');
});

test('malformed paper widths and oversized PNGs fail before any print attempt', () => {
    for (const overrides of [{ paperWidth: 0 }, { paperWidth: '80' }, { paperWidth: 81 },
        { imagePath: path.join(temporary, 'oversized.png') }, { imagePath: 'C:relative.png' }, { jobName: 'bad\nname' },
        { printableWidthMm: 0 }, { printableWidthMm: '72' }, { printableWidthMm: 19.9 }, { printableWidthMm: 81 },
        { paperWidth: 58, printableWidthMm: 59 }, { printableWidthMm: null }, { horizontalOffsetMm: 10.1 },
        { horizontalOffsetMm: -10.1 }, { horizontalOffsetMm: '2' }, { horizontalOffsetMm: null }]) {
        const { result, status } = runBackend(overrides);
        assert.equal(status, 1);
        assert.equal(result.success, false);
        assert.equal(result.submitted, false);
        assert.equal(result.submissionAttempted, false);
        assert.ok(['invalid_manifest', 'invalid_image'].includes(result.error));
    }
});

test('a nonexistent exact queue fails before invoking physical printing', () => {
    const { result, status } = runBackend({ printerName: `YALA-NONEXISTENT-TEST-${process.pid}-${Date.now()}` }, { preview: false });
    assert.equal(status, 1);
    assert.deepEqual(result, { success: false, submitted: false, submissionAttempted: false, error: 'printer_not_found' });
});

test('asymmetric hard margins and clipped driver bounds preserve both receipt edges', () => {
    const script = path.join(temporary, 'geometry.ps1');
    const directory = path.join(temporary, 'geometry-preview');
    const csharp = readFileSync(backend, 'utf8').match(/-TypeDefinition @"\r?\n([\s\S]*?)\r?\n"@/)[1];
    writeFileSync(script, `param([string] $Directory)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
${csharp}
public static class ReceiptGeometryPreviewTest
{
    public static string Run(string directory)
    {
        var geometry = typeof(WindowsReceiptGraphics).GetMethod("PrintableBounds",
            System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic, null,
            new Type[] { typeof(RectangleF), typeof(RectangleF), typeof(RectangleF) }, null);
        var layoutMethod = typeof(WindowsReceiptGraphics).GetMethod("LayoutBounds",
            System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic);
        RectangleF paper = new RectangleF(0, 0, 315, 250);
        RectangleF[] printable = new RectangleF[] {
            new RectangleF(12, 8, 283, 224), new RectangleF(12, 8, 315, 250),
            new RectangleF(12, 8, 283, 224), new RectangleF(-8, -6, 315, 250),
            new RectangleF(12, 8, 283, 224)
        };
        RectangleF[] visible = new RectangleF[] {
            new RectangleF(0, 0, 283, 224), new RectangleF(0, 0, 315, 250),
            new RectangleF(5, 3, 270, 220), new RectangleF(0, 0, 315, 250),
            new RectangleF(0, 0, 260, 224)
        };
        RectangleF[] expected = new RectangleF[] {
            new RectangleF(0, 0, 283, 224), new RectangleF(0, 0, 303, 242),
            new RectangleF(5, 3, 270, 220), new RectangleF(8, 6, 307, 244),
            new RectangleF(0, 0, 260, 224)
        };
        float[] configuredWidths = new float[] { 250, 250, 250, 250, 300 };
        float[] offsets = new float[] { -10, 10, 100, -100, 0 };
        RectangleF[] layouts = new RectangleF[] {
            new RectangleF(6.5f, 0, 250, 224), new RectangleF(36.5f, 0, 250, 242),
            new RectangleF(25, 3, 250, 220), new RectangleF(8, 6, 250, 244),
            new RectangleF(0, 0, 260, 224)
        };
        for (int index = 0; index < expected.Length; index++) {
            RectangleF actual = (RectangleF)geometry.Invoke(null, new object[] { paper, printable[index], visible[index] });
            if (actual != expected[index]) throw new Exception("Incorrect geometry case " + index);
            RectangleF layout = (RectangleF)layoutMethod.Invoke(null,
                new object[] { actual, configuredWidths[index], offsets[index] });
            if (layout != layouts[index]) throw new Exception("Incorrect centered/clamped layout case " + index);
        }
        foreach (RectangleF invalid in new RectangleF[] { RectangleF.Empty,
            new RectangleF(0, 0, Single.NaN, 250), new RectangleF(0, 0, 50, 250) }) {
            bool rejected = false;
            try { geometry.Invoke(null, new object[] { paper, invalid, visible[0] }); }
            catch (System.Reflection.TargetInvocationException error) {
                ReceiptPrintFailure failure = error.InnerException as ReceiptPrintFailure;
                rejected = failure != null && failure.Code == "invalid_paper_settings" && !failure.SubmissionAttempted;
            }
            if (!rejected) throw new Exception("Invalid geometry was accepted");
        }
        Directory.CreateDirectory(directory);
        PreviewPageInfo[] pages = null;
        using (Bitmap source = new Bitmap(640, 200))
        using (PrintDocument document = new PrintDocument()) {
            using (Graphics fixture = Graphics.FromImage(source)) {
                fixture.Clear(Color.White);
                fixture.FillRectangle(Brushes.Black, 0, 0, 10, source.Height);
                fixture.FillRectangle(Brushes.Black, source.Width - 10, 0, 10, source.Height);
                fixture.FillRectangle(Brushes.Black, 0, 0, source.Width, 10);
                fixture.FillRectangle(Brushes.Black, 0, source.Height - 10, source.Width, 10);
            }
            document.PrinterSettings.PrinterName = "Microsoft Print to PDF";
            document.DefaultPageSettings.PaperSize = new PaperSize("Synthetic receipt geometry", 315, 250);
            document.DefaultPageSettings.Margins = new Margins(0, 0, 0, 0);
            document.OriginAtMargins = false;
            PreviewPrintController controller = new PreviewPrintController();
            controller.UseAntiAlias = false;
            document.PrintController = controller;
            int pageIndex = 0;
            document.PrintPage += delegate(object sender, PrintPageEventArgs args) {
                RectangleF target = (RectangleF)geometry.Invoke(null,
                    new object[] { paper, printable[pageIndex], visible[pageIndex] });
                target = (RectangleF)layoutMethod.Invoke(null,
                    new object[] { target, configuredWidths[pageIndex], offsets[pageIndex] });
                args.Graphics.PageUnit = GraphicsUnit.Display;
                // Reproduce the printer's nonzero hard-margin origin on the PDF preview surface.
                args.Graphics.TranslateTransform(printable[pageIndex].X, printable[pageIndex].Y);
                args.Graphics.SetClip(visible[pageIndex]);
                args.Graphics.InterpolationMode = InterpolationMode.NearestNeighbor;
                args.Graphics.PixelOffsetMode = PixelOffsetMode.Half;
                args.Graphics.DrawImage(source,
                    new RectangleF(target.X, target.Y, target.Width, source.Height * target.Width / source.Width),
                    new RectangleF(0, 0, source.Width, source.Height), GraphicsUnit.Pixel);
                pageIndex++;
                args.HasMorePages = pageIndex < printable.Length;
            };
            document.Print();
            pages = controller.GetPreviewPageInfo();
            try {
                for (int index = 0; index < pages.Length; index++) {
                    using (Bitmap bitmap = new Bitmap(630, 500)) {
                        using (Graphics output = Graphics.FromImage(bitmap)) {
                            output.Clear(Color.White);
                            output.DrawImage(pages[index].Image, new Rectangle(0, 0, 630, 500));
                        }
                        bitmap.Save(Path.Combine(directory, "page-" + index + ".png"), ImageFormat.Png);
                    }
                }
            } finally { foreach (PreviewPageInfo page in pages) page.Image.Dispose(); }
        }
        return "{\\"success\\":true,\\"submitted\\":false,\\"pages\\":" + pages.Length + "}";
    }
}
"@
[ReceiptGeometryPreviewTest]::Run($Directory)
`, 'utf8');
    const response = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Directory', directory], {
        encoding: 'utf8', windowsHide: true, env: childEnvironment, timeout: 30000,
    }));
    assert.deepEqual(response, { success: true, submitted: false, pages: 5 });
    const pages = pixels(directory);
    const physicalEdges = [[37, 537], [97, 597], [74, 574], [0, 500], [24, 544]];
    pages.forEach((page, index) => {
        const [left, right] = physicalEdges[index];
        assert.ok(Math.abs(page.left - left) <= 2, `left receipt edge retained without adding a second hard margin in case ${index}`);
        assert.ok(Math.abs(page.right - (right - 1)) <= 2, `right receipt edge retained in case ${index}`);
        assert.ok(page.dark > 2000, 'border renders through the actual Windows preview controller');
    });
});
test('custom printable width and signed offsets preserve the complete bitmap', () => {
    for (const horizontalOffsetMm of [-10, 10]) {
        const { result, directory, status } = runBackend({ printableWidthMm: 60, horizontalOffsetMm });
        assert.equal(status, 0);
        assert.equal(result.submitted, false);
        assert.equal(result.pages, 1);
        assert.equal(result.printableWidthMm, 60);
        assert.equal(result.horizontalOffsetMm, horizontalOffsetMm);
        const [page] = pixels(directory);
        const expectedLeft = horizontalOffsetMm < 0 ? 0 : 160;
        assert.ok(Math.abs(page.left - expectedLeft) <= 2, 'signed adjustment moves the whole receipt within the paper');
        assert.ok(Math.abs(page.right - page.left - 479) <= 2, 'both bitmap edges remain visible at the configured width');
    }
    const { result, status } = runBackend({ printableWidthMm: 80, horizontalOffsetMm: -10 });
    assert.equal(status, 0);
    assert.equal(result.horizontalOffsetMm, 0, 'an offset cannot move a full-width image outside the printable area');
});