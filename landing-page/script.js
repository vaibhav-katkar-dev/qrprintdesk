/**
 * QrPrintDesk - Landing Page Interactive Script
 * Lightweight, zero dependencies, lightning fast
 */

document.addEventListener('DOMContentLoaded', () => {
  // ── 1. Interactive Xerox ROI Calculator ─────────────────────────────
  const sliderOrders = document.getElementById('calc-orders');
  const sliderPages = document.getElementById('calc-pages');
  const sliderRate = document.getElementById('calc-rate');

  const valOrders = document.getElementById('val-orders');
  const valPages = document.getElementById('val-pages');
  const valRate = document.getElementById('val-rate');

  const resMonthlyPrints = document.getElementById('res-monthly-prints');
  const resMonthlyRevenue = document.getElementById('res-monthly-revenue');
  const resTimeSaved = document.getElementById('res-time-saved');
  const resDuplexSaved = document.getElementById('res-duplex-saved');

  function calculateROI() {
    if (!sliderOrders || !sliderPages || !sliderRate) return;

    const ordersPerDay = parseInt(sliderOrders.value, 10);
    const pagesPerOrder = parseInt(sliderPages.value, 10);
    const bwRate = parseFloat(sliderRate.value);

    // Update display labels
    valOrders.textContent = `${ordersPerDay} orders/day`;
    valPages.textContent = `${pagesPerOrder} pgs/order`;
    valRate.textContent = `₹${bwRate.toFixed(2)}`;

    // Monthly calculations (assuming 26 operational shop days/month)
    const workingDays = 26;
    const monthlyOrders = ordersPerDay * workingDays;
    const monthlyPages = monthlyOrders * pagesPerOrder;
    const grossMonthlyRevenue = monthlyPages * bwRate;
    
    // Time saved: estimated 2.5 minutes wasted per manual WhatsApp/pendrive job
    const hoursSavedPerMonth = Math.round((monthlyOrders * 2.5) / 60);

    // Paper saved: approx 35% of xerox orders use 2-sided duplex
    const sheetsSavedViaDuplex = Math.round(monthlyPages * 0.35 * 0.5);

    // Formatted outputs
    resMonthlyPrints.textContent = monthlyPages.toLocaleString('en-IN');
    resMonthlyRevenue.textContent = `₹${Math.round(grossMonthlyRevenue).toLocaleString('en-IN')}`;
    resTimeSaved.textContent = `${hoursSavedPerMonth} Hours/mo`;
    resDuplexSaved.textContent = `${sheetsSavedViaDuplex.toLocaleString('en-IN')} Sheets`;
  }

  if (sliderOrders && sliderPages && sliderRate) {
    sliderOrders.addEventListener('input', calculateROI);
    sliderPages.addEventListener('input', calculateROI);
    sliderRate.addEventListener('input', calculateROI);
    calculateROI();
  }

  // ── 2. Product Showcase Tab Switcher ────────────────────────────────
  const tabs = document.querySelectorAll('.showcase-tab');
  const previewPwa = document.getElementById('preview-pwa');
  const previewDesktop = document.getElementById('preview-desktop');
  const previewUrl = document.getElementById('preview-url-text');

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      const target = tab.getAttribute('data-target');
      if (target === 'desktop') {
        previewPwa.style.display = 'none';
        previewDesktop.style.display = 'block';
        if (previewUrl) previewUrl.textContent = 'app://qrprintdesk-vendor-station/dashboard';
      } else {
        previewPwa.style.display = 'block';
        previewDesktop.style.display = 'none';
        if (previewUrl) previewUrl.textContent = 'https://qrprintdesk.in/shop/station-demo';
      }
    });
  });

  // ── 3. FAQ Accordion ────────────────────────────────────────────────
  const faqItems = document.querySelectorAll('.faq-item');
  faqItems.forEach(item => {
    const question = item.querySelector('.faq-question');
    question.addEventListener('click', () => {
      const isOpen = item.classList.contains('open');
      faqItems.forEach(i => i.classList.remove('open'));
      if (!isOpen) {
        item.classList.add('open');
      }
    });
  });

  // ── 4. Mobile Navigation Toggle ────────────────────────────────────
  const navToggle = document.querySelector('.nav-toggle');
  const navLinks = document.querySelector('.nav-links');

  if (navToggle && navLinks) {
    navToggle.addEventListener('click', () => {
      const isVisible = navLinks.style.display === 'flex';
      navLinks.style.display = isVisible ? 'none' : 'flex';
      if (!isVisible) {
        navLinks.style.flexDirection = 'column';
        navLinks.style.position = 'absolute';
        navLinks.style.top = '72px';
        navLinks.style.left = '0';
        navLinks.style.right = '0';
        navLinks.style.background = '#0e1422';
        navLinks.style.padding = '24px';
        navLinks.style.borderBottom = '1px solid rgba(255,255,255,0.1)';
        navLinks.style.boxShadow = '0 10px 25px rgba(0,0,0,0.5)';
      }
    });
  }
});
