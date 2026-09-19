const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
  'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function twoDigits(n) {
  if (n < 20) return ONES[n];
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  return TENS[tens] + (ones ? ' ' + ONES[ones] : '');
}

function threeDigits(n) {
  const hundred = Math.floor(n / 100);
  const rest = n % 100;
  let out = '';
  if (hundred) out += ONES[hundred] + ' Hundred';
  if (rest) out += (out ? ' ' : '') + twoDigits(rest);
  return out;
}

/**
 * Converts a number to words using the Indian numbering system
 * (Crore / Lakh / Thousand), e.g. 51510 -> "Fifty One Thousand Five Hundred Ten"
 */
function numberToWordsIndian(num) {
  num = Math.round(Number(num) || 0);
  if (num === 0) return 'Zero';
  if (num < 0) return 'Minus ' + numberToWordsIndian(-num);

  const crore = Math.floor(num / 10000000);
  num %= 10000000;
  const lakh = Math.floor(num / 100000);
  num %= 100000;
  const thousand = Math.floor(num / 1000);
  num %= 1000;
  const hundredPart = num;

  const parts = [];
  if (crore) parts.push(threeDigits(crore) + ' Crore');
  if (lakh) parts.push(twoDigits(lakh) + ' Lakh');
  if (thousand) parts.push(twoDigits(thousand) + ' Thousand');
  if (hundredPart) parts.push(threeDigits(hundredPart));

  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

function amountInWords(amount) {
  return numberToWordsIndian(amount) + ' Only';
}

module.exports = { numberToWordsIndian, amountInWords };
