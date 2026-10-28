[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string] $ManifestPath,
    [string] $PreviewDirectory
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$errorCode = 'invalid_manifest'
$submissionAttempted = $false

function Test-AbsolutePath([string] $value) {
    return $value -match '^(?:[a-zA-Z]:[\\/]|\\\\[^\\]+\\[^\\]+\\)'
}

try {
    if (-not (Test-AbsolutePath $ManifestPath) -or -not [IO.File]::Exists($ManifestPath)) { throw 'invalid_manifest' }
    if ((Get-Item -LiteralPath $ManifestPath).Length -gt 16384) { throw 'invalid_manifest' }
    $manifest = [IO.File]::ReadAllText($ManifestPath) | ConvertFrom-Json
    if ($null -eq $manifest -or $manifest -is [Array]) { throw 'invalid_manifest' }
    $fields = @($manifest.PSObject.Properties.Name)
    foreach ($required in @('printerName', 'paperWidth', 'jobName', 'imagePath')) {
        if ($fields -notcontains $required) { throw 'invalid_manifest' }
    }
    if ($manifest.printerName -isnot [string] -or [string]::IsNullOrWhiteSpace($manifest.printerName) -or $manifest.printerName.Length -gt 256 -or $manifest.printerName -match '[\x00-\x1f\x7f]') { throw 'invalid_manifest' }
    if ($manifest.paperWidth -is [string] -or $manifest.paperWidth -notin @(58, 80)) { throw 'invalid_manifest' }
    if ($manifest.jobName -isnot [string] -or [string]::IsNullOrWhiteSpace($manifest.jobName) -or $manifest.jobName.Length -gt 120 -or $manifest.jobName -match '[\x00-\x1f\x7f]') { throw 'invalid_manifest' }
    if ($manifest.imagePath -isnot [string] -or -not (Test-AbsolutePath $manifest.imagePath)) { throw 'invalid_manifest' }
    if ($PreviewDirectory -and -not (Test-AbsolutePath $PreviewDirectory)) { throw 'invalid_preview_directory' }

    $errorCode = 'graphics_backend_unavailable'
    Add-Type -AssemblyName System.Drawing
    Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Printing;
using System.IO;
using System.Runtime.InteropServices;

public sealed class ReceiptPrintFailure : Exception
{
    public string Code { get; private set; }
    public bool SubmissionAttempted { get; private set; }
    public ReceiptPrintFailure(string code, bool attempted = false) : base(code)
    {
        Code = code;
        SubmissionAttempted = attempted;
    }
}

public sealed class ReceiptPrintResult
{
    public bool Success { get; set; }
    public bool Submitted { get; set; }
    public bool Preview { get; set; }
    public int Pages { get; set; }
    public double PrintableWidthMm { get; set; }
}

public static class WindowsReceiptGraphics
{
    private const int MaximumPages = 100;
    private const int PreviewDpi = 203;
    private const long MaximumPixels = 20000000;

    private static Bitmap LoadMonochrome(string path, out bool[] inkRows)
    {
        inkRows = null;
        if (!File.Exists(path) || new FileInfo(path).Length > 20L * 1024 * 1024)
            throw new ReceiptPrintFailure("invalid_image");
        byte[] header = new byte[24];
        using (FileStream file = File.OpenRead(path))
        {
            if (file.Read(header, 0, header.Length) != header.Length ||
                header[0] != 137 || header[1] != 80 || header[2] != 78 || header[3] != 71 ||
                header[4] != 13 || header[5] != 10 || header[6] != 26 || header[7] != 10 ||
                header[8] != 0 || header[9] != 0 || header[10] != 0 || header[11] != 13 ||
                header[12] != 73 || header[13] != 72 || header[14] != 68 || header[15] != 82)
                throw new ReceiptPrintFailure("invalid_image");
            uint imageWidth = ((uint)header[16] << 24) | ((uint)header[17] << 16) | ((uint)header[18] << 8) | header[19];
            uint imageHeight = ((uint)header[20] << 24) | ((uint)header[21] << 16) | ((uint)header[22] << 8) | header[23];
            if (imageWidth < 1 || imageWidth > 2048 || imageHeight < 1 || imageHeight > 60000 ||
                (long)imageWidth * imageHeight > MaximumPixels)
                throw new ReceiptPrintFailure("invalid_image");
        }
        using (Image source = Image.FromFile(path, false))
        {
            if (source.RawFormat.Guid != ImageFormat.Png.Guid || source.Width < 1 || source.Width > 2048 ||
                source.Height < 1 || source.Height > 60000 || (long)source.Width * source.Height > MaximumPixels)
                throw new ReceiptPrintFailure("invalid_image");
            using (Bitmap rgb = new Bitmap(source.Width, source.Height, PixelFormat.Format32bppArgb))
            {
                using (Graphics graphics = Graphics.FromImage(rgb))
                {
                    graphics.Clear(Color.White);
                    graphics.DrawImageUnscaled(source, 0, 0);
                }
                inkRows = new bool[rgb.Height];
                Bitmap mono = new Bitmap(rgb.Width, rgb.Height, PixelFormat.Format1bppIndexed);
                ColorPalette palette = mono.Palette;
                palette.Entries[0] = Color.White;
                palette.Entries[1] = Color.Black;
                mono.Palette = palette;
                BitmapData input = null;
                BitmapData output = null;
                try
                {
                    Rectangle bounds = new Rectangle(0, 0, rgb.Width, rgb.Height);
                    input = rgb.LockBits(bounds, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
                    output = mono.LockBits(bounds, ImageLockMode.WriteOnly, PixelFormat.Format1bppIndexed);
                    byte[] row = new byte[Math.Abs(input.Stride)];
                    byte[] bits = new byte[Math.Abs(output.Stride)];
                    for (int y = 0; y < rgb.Height; y++)
                    {
                        Marshal.Copy(IntPtr.Add(input.Scan0, y * input.Stride), row, 0, row.Length);
                        Array.Clear(bits, 0, bits.Length);
                        for (int x = 0; x < rgb.Width; x++)
                        {
                            int offset = x * 4;
                            if (299 * row[offset + 2] + 587 * row[offset + 1] + 114 * row[offset] < 160000)
                            {
                                bits[x >> 3] |= (byte)(128 >> (x & 7));
                                inkRows[y] = true;
                            }
                        }
                        Marshal.Copy(bits, 0, IntPtr.Add(output.Scan0, y * output.Stride), bits.Length);
                    }
                }
                catch
                {
                    if (output != null) mono.UnlockBits(output);
                    output = null;
                    mono.Dispose();
                    throw;
                }
                finally
                {
                    if (input != null) rgb.UnlockBits(input);
                    if (output != null) mono.UnlockBits(output);
                }
                return mono;
            }
        }
    }

    private static int BreakSearchDepth(int width, int maximumRows)
    {
        return Math.Min(maximumRows / 4, Math.Max(16, width / 4));
    }

    private static int RowsForPage(int width, bool[] inkRows, int offset, int maximumRows)
    {
        int remaining = inkRows.Length - offset;
        if (remaining <= maximumRows) return remaining;
        int boundary = offset + maximumRows;
        int minimum = boundary - BreakSearchDepth(width, maximumRows);
        int whiteRows = 0;
        for (int row = boundary - 1; row >= minimum; row--)
        {
            whiteRows = inkRows[row] ? 0 : whiteRows + 1;
            if (whiteRows >= 4) return row + 2 - offset;
        }
        return maximumRows;
    }
    private static bool Installed(string requested)
    {
        foreach (string installed in PrinterSettings.InstalledPrinters)
            if (String.Equals(installed, requested, StringComparison.Ordinal)) return true;
        return false;
    }

    private static PaperSize SelectPaper(PrintDocument document, int width, int desiredHeight)
    {
        PaperSize best = null;
        int bestScore = Int32.MaxValue;
        foreach (PaperSize candidate in document.PrinterSettings.PaperSizes)
        {
            if (Math.Abs(candidate.Width - width) > 8 || candidate.Height < 80 || candidate.Height > 2362) continue;
            int score = candidate.Height >= desiredHeight ? candidate.Height - desiredHeight : 10000 - candidate.Height;
            if (score < bestScore) { best = candidate; bestScore = score; }
        }
        if (best != null) return best;
        PaperSize current = document.DefaultPageSettings.PaperSize;
        if (Math.Abs(current.Width - width) <= 8 && current.Height >= 80 && current.Height <= 2362) return current;
        return new PaperSize("Receipt", width, desiredHeight);
    }

    private static SizeF PrintableSize(PageSettings settings)
    {
        RectangleF area = settings.PrintableArea;
        float width = Math.Min(area.Width, settings.PaperSize.Width);
        float height = Math.Min(area.Height, settings.PaperSize.Height);
        if (Single.IsNaN(width) || Single.IsInfinity(width) || Single.IsNaN(height) || Single.IsInfinity(height) ||
            width < 78 || height < 78 || width > 2000 || height > 2362)
            throw new ReceiptPrintFailure("invalid_paper_settings");
        return new SizeF(width, height);
    }

    public static ReceiptPrintResult Execute(string printerName, int paperWidth, string jobName, string imagePath, string previewDirectory)
    {
        bool preview = !String.IsNullOrEmpty(previewDirectory);
        bool attempted = false;
        PreviewPageInfo[] previewPages = null;
        try
        {
            string printer = preview ? "Microsoft Print to PDF" : printerName;
            if (!Installed(printer)) throw new ReceiptPrintFailure(preview ? "preview_printer_unavailable" : "printer_not_found");
            if (preview)
            {
                if (Directory.Exists(previewDirectory) && Directory.GetFileSystemEntries(previewDirectory).Length != 0)
                    throw new ReceiptPrintFailure("preview_directory_not_empty");
                Directory.CreateDirectory(previewDirectory);
            }
            bool[] inkRows;
            using (Bitmap image = LoadMonochrome(imagePath, out inkRows))
            using (PrintDocument document = new PrintDocument())
            {
                document.PrinterSettings.PrinterName = printer;
                if (!document.PrinterSettings.IsValid) throw new ReceiptPrintFailure("printer_not_found");
                document.PrinterSettings.Copies = 1;
                document.PrinterSettings.Collate = false;
                if (document.PrinterSettings.CanDuplex) document.PrinterSettings.Duplex = Duplex.Simplex;
                document.DocumentName = jobName;
                document.OriginAtMargins = false;
                document.DefaultPageSettings.Color = false;
                document.DefaultPageSettings.Landscape = false;
                document.DefaultPageSettings.Margins = new Margins(0, 0, 0, 0);
                float requestedWidth = paperWidth * 100.0f / 25.4f;
                int width = (int)Math.Round(requestedWidth);
                int desiredHeight = (int)Math.Ceiling(image.Height * (double)width / image.Width + 20);
                desiredHeight = Math.Max(200, Math.Min(1169, desiredHeight));
                document.DefaultPageSettings.PaperSize = SelectPaper(document, width, desiredHeight);
                SizeF printable = PrintableSize(document.DefaultPageSettings);
                float targetWidth = Math.Min(requestedWidth, printable.Width);
                int rowsPerPage = (int)Math.Floor(printable.Height * image.Width / targetWidth);
                int minimumRowsPerPage = rowsPerPage - BreakSearchDepth(image.Width, rowsPerPage);
                double maximumPlannedPages = minimumRowsPerPage > 0 ? Math.Ceiling(image.Height / (double)minimumRowsPerPage) : Double.PositiveInfinity;
                if (rowsPerPage < 1 || maximumPlannedPages > MaximumPages)
                    throw new ReceiptPrintFailure("receipt_too_long");
                if (preview)
                {
                    long pagePixels = (long)Math.Ceiling(document.DefaultPageSettings.PaperSize.Width * PreviewDpi / 100.0) *
                        (long)Math.Ceiling(document.DefaultPageSettings.PaperSize.Height * PreviewDpi / 100.0);
                    if (pagePixels * maximumPlannedPages > 50000000)
                        throw new ReceiptPrintFailure("preview_too_large");
                }
                PreviewPrintController previewController = preview ? new PreviewPrintController() : null;
                if (preview) { previewController.UseAntiAlias = false; document.PrintController = previewController; }
                else document.PrintController = new StandardPrintController();
                int rowOffset = 0;
                int pages = 0;
                document.PrintPage += delegate(object sender, PrintPageEventArgs args)
                {
                    if (pages >= MaximumPages) throw new ReceiptPrintFailure("receipt_too_long", attempted);
                    SizeF available = PrintableSize(args.PageSettings);
                    float drawWidth = Math.Min(requestedWidth, available.Width);
                    int pageRows = RowsForPage(image.Width, inkRows, rowOffset, (int)Math.Floor(available.Height * image.Width / drawWidth));
                    if (pageRows < 1) throw new ReceiptPrintFailure("invalid_paper_settings", attempted);
                    float drawHeight = pageRows * drawWidth / image.Width;
                    args.Graphics.PageUnit = GraphicsUnit.Display;
                    args.Graphics.InterpolationMode = InterpolationMode.NearestNeighbor;
                    args.Graphics.PixelOffsetMode = PixelOffsetMode.Half;
                    args.Graphics.DrawImage(image, new RectangleF(0, 0, drawWidth, drawHeight),
                        new RectangleF(0, rowOffset, image.Width, pageRows), GraphicsUnit.Pixel);
                    rowOffset += pageRows;
                    pages++;
                    args.HasMorePages = rowOffset < image.Height;
                };
                attempted = !preview;
                document.Print();
                if (rowOffset != image.Height || pages < 1) throw new ReceiptPrintFailure("print_incomplete", attempted);
                if (preview)
                {
                    previewPages = previewController.GetPreviewPageInfo();
                    if (previewPages.Length != pages) throw new ReceiptPrintFailure("preview_incomplete");
                    for (int index = 0; index < previewPages.Length; index++)
                    {
                        PreviewPageInfo page = previewPages[index];
                        int pixelsWide = (int)Math.Ceiling(page.PhysicalSize.Width * PreviewDpi / 100.0);
                        int pixelsHigh = (int)Math.Ceiling(page.PhysicalSize.Height * PreviewDpi / 100.0);
                        using (Bitmap bitmap = new Bitmap(pixelsWide, pixelsHigh, PixelFormat.Format24bppRgb))
                        {
                            bitmap.SetResolution(PreviewDpi, PreviewDpi);
                            using (Graphics graphics = Graphics.FromImage(bitmap))
                            {
                                graphics.Clear(Color.White);
                                graphics.DrawImage(page.Image, new Rectangle(0, 0, pixelsWide, pixelsHigh));
                            }
                            bitmap.Save(Path.Combine(previewDirectory, "page-" + (index + 1).ToString("D3") + ".png"), ImageFormat.Png);
                        }
                    }
                }
                return new ReceiptPrintResult { Success = true, Submitted = !preview, Preview = preview, Pages = pages,
                    PrintableWidthMm = Math.Round(targetWidth * 25.4 / 100, 2) };
            }
        }
        catch (ReceiptPrintFailure error)
        {
            if (attempted && !error.SubmissionAttempted) throw new ReceiptPrintFailure(error.Code, true);
            throw;
        }
        catch { throw new ReceiptPrintFailure(attempted ? "print_failed" : "graphics_backend_failed", attempted); }
        finally
        {
            if (previewPages != null)
                foreach (PreviewPageInfo page in previewPages) page.Image.Dispose();
        }
    }
}
"@
    $result = [WindowsReceiptGraphics]::Execute($manifest.printerName, [int] $manifest.paperWidth, $manifest.jobName, $manifest.imagePath, $PreviewDirectory)
    [ordered]@{ success = $true; submitted = $result.Submitted; preview = $result.Preview; pages = $result.Pages; printableWidthMm = $result.PrintableWidthMm } | ConvertTo-Json -Compress
    exit 0
}
catch {
    $exception = $_.Exception
    while ($null -ne $exception) {
        if ($exception.GetType().Name -eq 'ReceiptPrintFailure') {
            $errorCode = $exception.Code
            $submissionAttempted = $exception.SubmissionAttempted
            break
        }
        $exception = $exception.InnerException
    }
    [ordered]@{ success = $false; submitted = $false; submissionAttempted = $submissionAttempted; error = $errorCode } | ConvertTo-Json -Compress
    exit 1
}
