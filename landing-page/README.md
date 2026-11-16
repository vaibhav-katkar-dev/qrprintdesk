# QrPrintDesk — Marketing & Landing Page Website

This directory contains the completely standalone, static, high-converting marketing landing page for **QrPrintDesk**.

## 🌟 Key Features
- **Zero Server Dependencies**: 100% Pure HTML5, CSS3, and modern Vanilla JavaScript.
- **Fast & Responsive**: Mobile-first design, dark-mode glassmorphism accents, SEO-optimized meta tags.
- **Interactive Xerox ROI Calculator**: Allows photocopy and xerox shop owners to slide their daily orders and page rates to calculate monthly profits, hours saved, and paper savings.
- **Showcase Tab Switcher**: Live interactive preview toggle between Customer Mobile PWA and Vendor Windows Desktop Station.
- **FAQ Accordion**: Answers key questions about Pay at Counter (Cash), UPI Easy Split daily payouts, printer compatibility, and privacy.

---

## 🚀 How to Deploy / Host (Completely Independent of your Backend Server)

You can host this landing page on any free or low-cost static hosting service in under 2 minutes:

### 1. Vercel (Recommended)
1. Install Vercel CLI (`npm i -g vercel`) or go to [vercel.com](https://vercel.com).
2. Click **Add New Project** &rarr; Select your GitHub repository.
3. Set the **Root Directory** to `landing-page`.
4. Click **Deploy**. Your custom domain (e.g. `qrprintdesk.com` or `www.qrprintdesk.in`) can be connected with 1 click.

### 2. Cloudflare Pages
1. Go to your Cloudflare Dashboard &rarr; **Workers & Pages**.
2. Click **Create Application** &rarr; **Pages** &rarr; Connect to Git.
3. Set the **Build output directory** to `/landing-page`.
4. Deploy! Enjoy unlimited bandwidth on Cloudflare's global edge network.

### 3. Netlify
1. Drag and drop the `landing-page` folder directly into [app.netlify.com/drop](https://app.netlify.com/drop), or connect via Git.
2. Publish directory: `landing-page`.

### 4. GitHub Pages
1. In your repository settings, go to **Pages**.
2. Select branch `main` and set the folder to `/landing-page`.
3. Save and your site will be live instantly.

---

## 📁 Directory Structure
```
landing-page/
├── assets/
│   ├── icon.ico
│   ├── icon.png
│   ├── logo.png
│   ├── logo_dark.png
│   ├── printer_canon.png
│   └── printer_preview.png
├── index.html        # Main semantic landing page
├── style.css         # Modern, responsive stylesheet
├── script.js         # Interactive ROI calculator & tabs
└── README.md         # Deployment documentation
```
