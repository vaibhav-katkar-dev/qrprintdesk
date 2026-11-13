export interface PrintPricingOptions {
  pageCount: number;
  copies: number;
  colorMode: 'monochrome' | 'color';
  duplexMode: 'simplex' | 'duplexlong';
}

export interface ShopPricingConfig {
  bwPerPagePaise: number;
  colorPerPagePaise: number;
  duplexDiscountPaise: number;
}

export interface PricingBreakdown {
  amountPaise: number;
  platformFeePaise: number;
  vendorSharePaise: number;
  currency: 'INR';
}

export function calculateOrderPrice(
  options: PrintPricingOptions,
  shopPricing: ShopPricingConfig,
  platformFeePercent: number = 0
): PricingBreakdown {
  const baseRate = options.colorMode === 'color' 
    ? shopPricing.colorPerPagePaise 
    : shopPricing.bwPerPagePaise;

  let perPageRate = baseRate;
  if (options.duplexMode === 'duplexlong' && shopPricing.duplexDiscountPaise > 0) {
    perPageRate = Math.max(1, perPageRate - shopPricing.duplexDiscountPaise);
  }

  const grossPaise = Math.round(perPageRate * options.pageCount * Math.max(1, options.copies));
  const platformFeePaise = Math.round((grossPaise * platformFeePercent) / 100);
  const vendorSharePaise = grossPaise - platformFeePaise;

  return {
    amountPaise: grossPaise,
    platformFeePaise,
    vendorSharePaise,
    currency: 'INR'
  };
}
