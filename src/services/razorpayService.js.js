// razorpayService.js
//
// SCOPE: "Platform को Support करें" donation flow ONLY.
// This is intentionally separate from the existing payWithRazorpay()
// function used by the (currently disabled) vendor subscription-fee
// flow in src/App.jsx — that function is untouched by this file.
//
// Frontend never sees the Razorpay Key Secret. Order creation and
// payment-signature verification both happen server-side via Firebase
// Cloud Functions (see functions/index.js).

import { httpsCallable } from "firebase/functions";
import { functions } from "../firebase.js";

const RAZORPAY_CHECKOUT_SRC = "https://checkout.razorpay.com/v1/checkout.js";

function loadRazorpayCheckoutScript() {
  return new Promise((resolve, reject) => {
    if (window.Razorpay) {
      resolve();
      return;
    }
    const existing = document.querySelector('script[src="' + RAZORPAY_CHECKOUT_SRC + '"]');
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("Razorpay script load नहीं हो पाई।")));
      return;
    }
    const script = document.createElement("script");
    script.src = RAZORPAY_CHECKOUT_SRC;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Razorpay script load नहीं हो पाई।"));
    document.body.appendChild(script);
  });
}

/**
 * payDonationWithRazorpay
 *
 * @param {Object} params
 * @param {number} params.amountInRupees - donation amount in rupees (e.g. 51 for ₹51)
 * @param {string} params.razorpayKeyId - public Razorpay Key ID (safe for frontend)
 * @param {string} [params.donorName] - optional, prefill only
 * @param {(paymentId: string) => void} params.onSuccess - called after server-side verification succeeds
 * @param {(message: string) => void} params.onFailure - called on failure/cancel/verification mismatch.
 *        message === "cancelled" specifically means the user closed the Checkout modal.
 */
export async function payDonationWithRazorpay({ amountInRupees, razorpayKeyId, donorName, onSuccess, onFailure }) {
  try {
    if (!amountInRupees || amountInRupees <= 0) {
      onFailure("कृपया सही राशि चुनें।");
      return;
    }
    if (!razorpayKeyId || razorpayKeyId.indexOf("XXXX") !== -1) {
      onFailure("Payment अभी उपलब्ध नहीं है — कृपया बाद में try करें।");
      return;
    }

    await loadRazorpayCheckoutScript();

    const amountInPaise = Math.round(amountInRupees * 100);
    const createOrder = httpsCallable(functions, "createRazorpayOrder");
    const orderResult = await createOrder({ amount: amountInPaise });
    const { orderId, amount, currency } = orderResult.data || {};

    if (!orderId) {
      onFailure("Order create नहीं हो पाया, फिर से try करें।");
      return;
    }

    const options = {
      key: razorpayKeyId,
      amount,
      currency,
      name: "हमारी मिट्टी की दुकान",
      description: "Platform को Support करें",
      order_id: orderId,
      prefill: { name: donorName || "" },
      theme: { color: "#A8472E" },
      handler: async function (response) {
        try {
          const verifyPayment = httpsCallable(functions, "verifyRazorpayPayment");
          const verifyResult = await verifyPayment({
            razorpay_order_id: response.razorpay_order_id,
            razorpay_payment_id: response.razorpay_payment_id,
            razorpay_signature: response.razorpay_signature,
          });
          if (verifyResult.data && verifyResult.data.verified) {
            onSuccess(response.razorpay_payment_id);
          } else {
            onFailure("Payment verify नहीं हो पाया, कृपया support team से संपर्क करें।");
          }
        } catch (verifyErr) {
          onFailure("Payment verify नहीं हो पाया: " + (verifyErr.message || "कृपया फिर से try करें।"));
        }
      },
      modal: {
        ondismiss: function () {
          onFailure("cancelled");
        },
      },
    };

    const rzp = new window.Razorpay(options);
    rzp.on("payment.failed", function (response) {
      onFailure((response.error && response.error.description) || "Payment fail हो गया, फिर से try करें।");
    });
    rzp.open();
  } catch (err) {
    onFailure(err.message || "कुछ गलत हो गया, फिर से try करें।");
  }
}
