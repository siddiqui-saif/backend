// Backend pe wahi rules jo frontend (src/utils/validators.js) mein hain.
// Client ke check bypass ho sakte hain, isliye asal enforcement yahan hoti hai.

const LIMITS = {
  name: { min: 2, max: 60 },
  email: { max: 100 },
  address: { min: 10, max: 250 },
  landmark: { max: 100 },
  orderNote: { max: 200 },
  exchangeNote: { max: 300 },
  password: { min: 8, max: 64 },
  businessName: { min: 2, max: 100 },
  city: { min: 2, max: 60 },
  interest: { max: 150 },
  message: { max: 500 },
};

const PHONE_ERROR = 'Enter a valid Pakistani mobile number, for example 0300 1234567.';

const NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M} .'’-]*$/u;
const BUSINESS_RE = /^[\p{L}\p{N}][\p{L}\p{N}\p{M} &.,'’()\/-]*$/u;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function cleanSpaces(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function countLetters(value) {
  return (value.match(/\p{L}/gu) || []).length;
}

// Kisi bhi format se 03XXXXXXXXX banata hai. Galat number ho to null.
function normalizePkPhone(input) {
  let d = String(input == null ? '' : input).replace(/\D/g, '');
  if (d.startsWith('0092')) d = d.slice(4);
  else if (d.startsWith('92') && d.length === 12) d = d.slice(2);
  else if (d.startsWith('0') && d.length === 11) d = d.slice(1);
  return /^3\d{9}$/.test(d) ? '0' + d : null;
}

function validateName(value, label = 'Name') {
  const v = cleanSpaces(value);
  if (!v) return `${label} is required.`;
  if (v.length < LIMITS.name.min) return `${label} must be at least ${LIMITS.name.min} characters.`;
  if (v.length > LIMITS.name.max) return `${label} must be ${LIMITS.name.max} characters or fewer.`;
  if (!NAME_RE.test(v) || countLetters(v) < 2) return `${label} can only contain letters, spaces, and . ' -`;
  return '';
}

function validateEmail(value, required = false) {
  const v = String(value == null ? '' : value).trim().toLowerCase();
  if (!v) return required ? 'Email is required.' : '';
  if (v.length > LIMITS.email.max) return `Email must be ${LIMITS.email.max} characters or fewer.`;
  if (!EMAIL_RE.test(v)) return 'Enter a valid email address, for example name@example.com.';
  return '';
}

function validateAddress(value) {
  const v = cleanSpaces(value);
  if (!v) return 'Delivery address is required.';
  if (v.length < LIMITS.address.min) return `Please enter a complete address (at least ${LIMITS.address.min} characters).`;
  if (v.length > LIMITS.address.max) return `Address must be ${LIMITS.address.max} characters or fewer.`;
  if (countLetters(v) < 4) return 'Address should include an area or street name, not just numbers.';
  return '';
}

function validateOptionalText(value, max, label = 'This field') {
  if (String(value == null ? '' : value).trim().length > max) return `${label} must be ${max} characters or fewer.`;
  return '';
}

function validatePassword(value) {
  const v = String(value == null ? '' : value);
  if (!v) return 'Password is required.';
  if (v.length < LIMITS.password.min) return `Password must be at least ${LIMITS.password.min} characters.`;
  if (v.length > LIMITS.password.max) return `Password must be ${LIMITS.password.max} characters or fewer.`;
  if (!/\d/.test(v)) return 'Password must include at least one number.';
  return '';
}

function validateBusinessName(value) {
  const v = cleanSpaces(value);
  if (!v) return 'Business name is required.';
  if (v.length < LIMITS.businessName.min) return `Business name must be at least ${LIMITS.businessName.min} characters.`;
  if (v.length > LIMITS.businessName.max) return `Business name must be ${LIMITS.businessName.max} characters or fewer.`;
  if (!BUSINESS_RE.test(v) || countLetters(v) < 2) return 'Business name contains characters that are not allowed.';
  return '';
}

function validateCity(value) {
  const v = cleanSpaces(value);
  if (!v) return '';
  if (v.length < LIMITS.city.min) return `City must be at least ${LIMITS.city.min} characters.`;
  if (v.length > LIMITS.city.max) return `City must be ${LIMITS.city.max} characters or fewer.`;
  if (!NAME_RE.test(v) || countLetters(v) < 2) return 'City can only contain letters and spaces.';
  return '';
}

function validateWholesaleQuantity(value) {
  const v = String(value == null ? '' : value).trim();
  if (!v) return '';
  const m = v.match(/^(\d{1,6})(?:\s*[-–]\s*(\d{1,6}))?$/);
  if (!m) return 'Enter a number or a range, for example 200 or 200-500.';
  if (Number(m[1]) < 1) return 'Quantity must be at least 1.';
  if (m[2] && Number(m[2]) < Number(m[1])) return 'The second number must be larger, for example 200-500.';
  return '';
}

// ---------- Route-level checks: { error, clean } wapas karte hain ----------
function validateCheckout(body) {
  const b = body || {};
  const name = cleanSpaces(b.customer_name);
  const phone = normalizePkPhone(b.phone);
  const address = cleanSpaces(b.address);
  const landmark = cleanSpaces(b.landmark);
  const note = cleanSpaces(b.customer_note);

  const error =
    validateName(name, 'Full name') ||
    (phone ? '' : PHONE_ERROR) ||
    validateAddress(address) ||
    validateOptionalText(landmark, LIMITS.landmark, 'Landmark') ||
    validateOptionalText(note, LIMITS.orderNote, 'Order note');

  return {
    error: error || null,
    clean: { customer_name: name, phone, address, landmark: landmark || null, customer_note: note || null },
  };
}

function validateRegistration(body) {
  const b = body || {};
  const name = cleanSpaces(b.name);
  const phone = normalizePkPhone(b.phone);
  const email = String(b.email == null ? '' : b.email).trim().toLowerCase();
  const password = String(b.password == null ? '' : b.password);

  const error =
    validateName(name, 'Full name') ||
    (phone ? '' : PHONE_ERROR) ||
    validateEmail(email, false) ||
    validatePassword(password);

  return { error: error || null, clean: { name, phone, email: email || null, password } };
}

function validateProfile(body) {
  const b = body || {};
  const name = cleanSpaces(b.name);
  const email = String(b.email == null ? '' : b.email).trim().toLowerCase();

  const error = validateName(name, 'Full name') || validateEmail(email, false);

  return { error: error || null, clean: { name, email: email || null } };
}

function validateWholesale(body) {
  const b = body || {};
  const business = cleanSpaces(b.business_name);
  const contact = cleanSpaces(b.contact_person);
  const phone = normalizePkPhone(b.phone);
  const city = cleanSpaces(b.city);
  const interest = cleanSpaces(b.interested_in);
  const quantity = cleanSpaces(b.estimated_quantity);
  const message = String(b.message == null ? '' : b.message).trim();

  const error =
    validateBusinessName(business) ||
    validateName(contact, 'Contact person') ||
    (phone ? '' : PHONE_ERROR) ||
    validateCity(city) ||
    validateOptionalText(interest, LIMITS.interest, 'Interested in') ||
    validateWholesaleQuantity(quantity) ||
    validateOptionalText(message, LIMITS.message, 'Message');

  return {
    error: error || null,
    clean: {
      business_name: business,
      contact_person: contact,
      phone,
      city: city || null,
      interested_in: interest || null,
      estimated_quantity: quantity || null,
      message: message || null,
    },
  };
}

module.exports = {
  LIMITS,
  PHONE_ERROR,
  cleanSpaces,
  normalizePkPhone,
  validateName,
  validateEmail,
  validateAddress,
  validateOptionalText,
  validatePassword,
  validateBusinessName,
  validateCity,
  validateWholesaleQuantity,
  validateCheckout,
  validateRegistration,
  validateProfile,
  validateWholesale,
};