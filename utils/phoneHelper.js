// Phone number ko normalize karta hai - sirf digits rakhta hai
function normalizePhone(phone) {
  if (!phone) return phone;
  return phone.replace(/[^0-9]/g, '');
}

module.exports = { normalizePhone };