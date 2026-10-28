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
    assert.ok(result.printableWidthMm > 65 && result.printableWidthMm <= 80);
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
    assert.ok(result.printableWidthMm > 45 && result.printableWidthMm <= 58);
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
        { imagePath: path.join(temporary, 'oversized.png') }, { imagePath: 'C:relative.png' }, { jobName: 'bad\nname' }]) {
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
