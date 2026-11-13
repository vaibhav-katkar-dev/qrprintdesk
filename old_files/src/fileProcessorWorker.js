import { parentPort, workerData } from 'worker_threads';
import fs from 'fs';
import { PDFDocument } from 'pdf-lib';

function checkMagicBytes(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const fd = fs.openSync(filePath, 'r');
  const headerBuf = Buffer.alloc(16);
  fs.readSync(fd, headerBuf, 0, 16, 0);
  fs.closeSync(fd);

  if (headerBuf[0] === 0x25 && headerBuf[1] === 0x50 && headerBuf[2] === 0x44 && headerBuf[3] === 0x46 && headerBuf[4] === 0x2D) {
    return 'pdf';
  } else if (headerBuf[0] === 0xFF && headerBuf[1] === 0xD8 && headerBuf[2] === 0xFF) {
    return 'jpg';
  } else if (
    headerBuf[0] === 0x89 && headerBuf[1] === 0x50 && headerBuf[2] === 0x4E && headerBuf[3] === 0x47 &&
    headerBuf[4] === 0x0D && headerBuf[5] === 0x0A && headerBuf[6] === 0x1A && headerBuf[7] === 0x0A
  ) {
    return 'png';
  }
  return null;
}

function parsePageRange(rangeStr, totalPages) {
  if (!rangeStr || rangeStr.trim().toLowerCase() === 'all') {
    return Array.from({ length: totalPages }, (_, i) => i);
  }
  const indices = new Set();
  const parts = rangeStr.split(',');
  for (const p of parts) {
    const trimmed = p.trim();
    if (!trimmed) continue;
    if (trimmed.includes('-')) {
      const [startStr, endStr] = trimmed.split('-');
      const start = parseInt(startStr, 10);
      const end = parseInt(endStr, 10);
      if (!isNaN(start) && !isNaN(end)) {
        const from = Math.max(1, Math.min(start, end));
        const to = Math.min(totalPages, Math.max(start, end));
        for (let i = from; i <= to; i++) {
          indices.add(i - 1); // 0-based index
        }
      }
    } else {
      const num = parseInt(trimmed, 10);
      if (!isNaN(num) && num >= 1 && num <= totalPages) {
        indices.add(num - 1);
      }
    }
  }
  const result = Array.from(indices).sort((a, b) => a - b);
  return result.length > 0 ? result : Array.from({ length: totalPages }, (_, i) => i);
}

async function convertTo2on1(sourceDoc, selectedIndices) {
  // CRITICAL FIX: pdf-lib's embedPdf() cannot reliably embed pages that were
  // built via copyPages() on the same in-memory doc because those page nodes
  // reference XObjects from other loaded documents. We must serialize the
  // combined doc to bytes and reload it as a fresh standalone document first.
  // Without this, embedded pages render as blank on the 2-on-1 sheet.
  const serializedBytes = await sourceDoc.save();
  const reloadedDoc = await PDFDocument.load(serializedBytes);

  // Ensure all pages have a Contents stream (pdf-lib embedPdf requires it)
  for (const page of reloadedDoc.getPages()) {
    if (!page.node.Contents()) {
      // Draw a 0-opacity 1x1 rectangle to create a valid content stream
      page.drawRectangle({ x: 0, y: 0, width: 1, height: 1, opacity: 0 });
    }
  }

  const nupDoc = await PDFDocument.create();
  // Standard A4 Landscape sheet in points (841.89 x 595.28)
  const sheetWidth = 841.89;
  const sheetHeight = 595.28;
  const margin = 18;
  const gap = 14;
  const halfWidth = (sheetWidth - margin * 2 - gap) / 2;
  const halfHeight = sheetHeight - margin * 2;

  const embeddedPages = await nupDoc.embedPdf(reloadedDoc, selectedIndices);

  for (let i = 0; i < embeddedPages.length; i += 2) {
    const sheet = nupDoc.addPage([sheetWidth, sheetHeight]);

    // Left page — guard against zero/undefined dimensions
    const leftPage = embeddedPages[i];
    const leftW_raw = (leftPage.width && leftPage.width > 0) ? leftPage.width : 595.28;
    const leftH_raw = (leftPage.height && leftPage.height > 0) ? leftPage.height : 841.89;
    const leftScale = Math.min(halfWidth / leftW_raw, halfHeight / leftH_raw);
    const leftW = leftW_raw * leftScale;
    const leftH = leftH_raw * leftScale;
    const leftX = margin + (halfWidth - leftW) / 2;
    const leftY = margin + (halfHeight - leftH) / 2;
    sheet.drawPage(leftPage, { x: leftX, y: leftY, width: leftW, height: leftH });

    // Right page (if available) — guard against zero/undefined dimensions
    if (i + 1 < embeddedPages.length) {
      const rightPage = embeddedPages[i + 1];
      const rightW_raw = (rightPage.width && rightPage.width > 0) ? rightPage.width : 595.28;
      const rightH_raw = (rightPage.height && rightPage.height > 0) ? rightPage.height : 841.89;
      const rightScale = Math.min(halfWidth / rightW_raw, halfHeight / rightH_raw);
      const rightW = rightW_raw * rightScale;
      const rightH = rightH_raw * rightScale;
      const rightX = margin + halfWidth + gap + (halfWidth - rightW) / 2;
      const rightY = margin + (halfHeight - rightH) / 2;
      sheet.drawPage(rightPage, { x: rightX, y: rightY, width: rightW, height: rightH });
    }
  }

  return nupDoc;
}

async function processFiles(fileList, options = {}) {
  try {
    const filePaths = Array.isArray(fileList) ? fileList : [fileList];
    if (filePaths.length === 0) {
      return { success: false, error: 'No files provided for processing.' };
    }

    const pagesPerSheet = options.pagesPerSheet === 2 ? 2 : 1;
    const pageRange = options.pageRange || 'all';

    // Step 1: Validate all files exist and have valid magic bytes
    for (const fp of filePaths) {
      if (!fs.existsSync(fp)) {
        return { success: false, error: 'Uploaded file missing on server.' };
      }
      const detected = checkMagicBytes(fp);
      if (!detected) {
        return {
          success: false,
          error: 'File format not recognized. Magic bytes do not match valid PDF, JPG, or PNG.'
        };
      }
    }

    // Combine all inputs into a master PDF
    const combinedPdf = await PDFDocument.create();

    for (const fp of filePaths) {
      const detected = checkMagicBytes(fp);
      const fileBytes = fs.readFileSync(fp);

      if (detected === 'pdf') {
        let pdfDoc;
        try {
          pdfDoc = await PDFDocument.load(fileBytes, { ignoreEncryption: false });
        } catch (err) {
          const msg = (err && err.message) ? err.message.toLowerCase() : '';
          if (msg.includes('encrypt') || msg.includes('password') || msg.includes('decrypt')) {
            return {
              success: false,
              error: 'Password-protected PDFs cannot be printed. Please unlock the file and upload again.'
            };
          }
          return { success: false, error: `Unreadable PDF in uploaded batch: ${err.message || ''}` };
        }

        if (pdfDoc.isEncrypted) {
          return {
            success: false,
            error: 'Password-protected PDFs cannot be printed. Please unlock the file and upload again.'
          };
        }

        const copiedPages = await combinedPdf.copyPages(pdfDoc, pdfDoc.getPageIndices());
        for (const page of copiedPages) {
          combinedPdf.addPage(page);
        }
      } else if (detected === 'jpg') {
        let embeddedImg;
        try {
          embeddedImg = await combinedPdf.embedJpg(fileBytes);
        } catch (err) {
          return { success: false, error: 'Corrupt or unreadable JPG image in batch.' };
        }
        const page = combinedPdf.addPage([embeddedImg.width, embeddedImg.height]);
        page.drawImage(embeddedImg, {
          x: 0,
          y: 0,
          width: embeddedImg.width,
          height: embeddedImg.height
        });
      } else if (detected === 'png') {
        let embeddedImg;
        try {
          embeddedImg = await combinedPdf.embedPng(fileBytes);
        } catch (err) {
          return { success: false, error: 'Corrupt or unreadable PNG image in batch.' };
        }
        const page = combinedPdf.addPage([embeddedImg.width, embeddedImg.height]);
        page.drawImage(embeddedImg, {
          x: 0,
          y: 0,
          width: embeddedImg.width,
          height: embeddedImg.height
        });
      }
    }

    const totalRawPages = combinedPdf.getPageCount();
    if (totalRawPages < 1) {
      return { success: false, error: 'Combined document contains no pages.' };
    }

    // Step 2: Handle custom page range filtering
    const selectedIndices = parsePageRange(pageRange, totalRawPages);
    if (selectedIndices.length === 0) {
      return { success: false, error: 'Selected page range contains no valid pages.' };
    }

    // Step 3: Handle 2-on-1 N-up layout or page range sub-selection
    let finalDoc = combinedPdf;
    let is2on1 = false;
    if (pagesPerSheet === 2) {
      finalDoc = await convertTo2on1(combinedPdf, selectedIndices);
      is2on1 = true;
    } else if (selectedIndices.length < totalRawPages) {
      // Create filtered doc with only selected pages
      const filteredDoc = await PDFDocument.create();
      const copied = await filteredDoc.copyPages(combinedPdf, selectedIndices);
      for (const p of copied) {
        filteredDoc.addPage(p);
      }
      finalDoc = filteredDoc;
    }

    const finalPageCount = finalDoc.getPageCount();
    const finalBytes = await finalDoc.save();
    const finalOutputPath = `${filePaths[0]}.pdf`;
    fs.writeFileSync(finalOutputPath, finalBytes);

    // Clean up temporary upload parts
    for (const fp of filePaths) {
      if (fp !== finalOutputPath) {
        try { fs.unlinkSync(fp); } catch {}
      }
    }

    return {
      success: true,
      fileType: 'pdf',
      processedPath: finalOutputPath,
      pageCount: finalPageCount,
      originalPageCount: totalRawPages,
      is2on1
    };
  } catch (err) {
    return {
      success: false,
      error: `Failed to process document(s): ${err.message || 'internal error'}`
    };
  }
}

if (workerData) {
  const targetFiles = workerData.filePaths || (workerData.filePath ? [workerData.filePath] : []);
  const options = {
    pagesPerSheet: workerData.pagesPerSheet || 1,
    pageRange: workerData.pageRange || 'all',
    orientation: workerData.orientation || 'auto'
  };
  processFiles(targetFiles, options).then((result) => {
    parentPort.postMessage(result);
  }).catch((err) => {
    parentPort.postMessage({ success: false, error: err.message });
  });
}
