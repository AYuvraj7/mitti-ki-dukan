/**
 * Mitti Ki Dukan — Cloud Functions
 *
 * SCOPE (Phase 1): "Platform को Support करें" donation flow ONLY.
 * This file does NOT touch seller payments, customer checkout, or the
 * vendor subscription-fee flow — those remain untouched (UPI-direct,
 * as before). Do not add unrelated functions to this file without
 * updating this scope comment.
 *
 * Two callable functions:
 *   - createRazorpayOrder   : creates a real Razorpay Order server-side
 *   - verifyRazorpayPayment : verifies payment signature server-side
 *
 * Phase 1 explicitly does NOT write to Firestore. Donation history /
 * analytics is deferred to a later phase per product decision.
 *
 * Secrets required (set via Firebase CLI before deploy):
 *   firebase functions:secrets:set RAZORPAY_KEY_SECRET
 *
 * Config required (not secret, but kept as a param for clean deploys):
 *   firebase functions:config or a Secret — see RAZORPAY_KEY_ID below.
 *   We use defineSecret for both for consistent secret-management hygiene,
 *   even though the Key ID itself is not sensitive.
 */

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const Razorpay = require("razorpay");
const crypto = require("crypto");

const RAZORPAY_KEY_ID = defineSecret("RAZORPAY_KEY_ID");
const RAZORPAY_KEY_SECRET = defineSecret("RAZORPAY_KEY_SECRET");

// Region kept consistent with the frontend's getFunctions(app, "asia-south1")
const REGION = "asia-south1";

// Donation amount guardrails (in paise). ₹1 minimum, ₹1,00,000 maximum.
const MIN_AMOUNT_PAISE = 100;
const MAX_AMOUNT_PAISE = 10000000;

/**
 * createRazorpayOrder
 * Input:  { amount: number }  — amount in paise (e.g. 5100 for ₹51)
 * Output: { orderId, amount, currency }
 */
exports.createRazorpayOrder = onCall(
  { region: REGION, secrets: [RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET] },
  async (request) => {
    const amount = request.data && request.data.amount;

    if (
      typeof amount !== "number" ||
      !Number.isInteger(amount) ||
      amount < MIN_AMOUNT_PAISE ||
      amount > MAX_AMOUNT_PAISE
    ) {
      throw new HttpsError(
        "invalid-argument",
        "अमान्य राशि — कृपया सही amount भेजें (\u20B91 से \u20B91,00,000 के बीच)।"
      );
    }

    const instance = new Razorpay({
      key_id: RAZORPAY_KEY_ID.value(),
      key_secret: RAZORPAY_KEY_SECRET.value(),
    });

    try {
      const order = await instance.orders.create({
        amount,
        currency: "INR",
        receipt: "donation_" + Date.now(),
        notes: { purpose: "platform_support_donation" },
      });

      return {
        orderId: order.id,
        amount: order.amount,
        currency: order.currency,
      };
    } catch (err) {
      console.error("createRazorpayOrder failed:", err);
      throw new HttpsError(
        "internal",
        "Order create नहीं हो पाया, कृपया फिर से try करें।"
      );
    }
  }
);

/**
 * verifyRazorpayPayment
 * Input:  { razorpay_order_id, razorpay_payment_id, razorpay_signature }
 * Output: { verified: true, paymentId, orderId }
 *
 * Verifies Razorpay's HMAC SHA256 signature server-side using the Key
 * Secret. The Key Secret never leaves this function.
 */
exports.verifyRazorpayPayment = onCall(
  { region: REGION, secrets: [RAZORPAY_KEY_SECRET] },
  async (request) => {
    const data = request.data || {};
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = data;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      throw new HttpsError(
        "invalid-argument",
        "Payment verification के लिए ज़रूरी details missing हैं।"
      );
    }

    const expectedSignature = crypto
      .createHmac("sha256", RAZORPAY_KEY_SECRET.value())
      .update(razorpay_order_id + "|" + razorpay_payment_id)
      .digest("hex");

    const isValid = expectedSignature === razorpay_signature;

    if (!isValid) {
      throw new HttpsError(
        "permission-denied",
        "Payment verify नहीं हो पाया — signature match नहीं हुआ।"
      );
    }

    // Phase 1: verification only, no Firestore write.
    // Phase 2 (future): persist a `donations/{id}` document here.

    return {
      verified: true,
      paymentId: razorpay_payment_id,
      orderId: razorpay_order_id,
    };
  }
);
