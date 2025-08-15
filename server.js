// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const sgMail = require('@sendgrid/mail');

// Stripe (optionally pin apiVersion)
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY, {
  // apiVersion: '2024-06-20',
});

if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

const app = express();
const PORT = process.env.PORT || 4242;

// --- Config ---
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
const FRONTEND_BASE_URL =
  process.env.FRONTEND_BASE_URL || 'https://gray-bay-02034850f.2.azurestaticapps.net';
const isDev = process.env.NODE_ENV !== 'production';

// --- Utils: compute gross when donor covers fees (2.9% + $0.30) ---
function computeGrossCents(baseAmountCents, { coverFees }) {
  if (!coverFees) return Number(baseAmountCents);
  return Math.ceil((Number(baseAmountCents) + 30) / (1 - 0.029));
}

// ----------------------------
// 1) Webhook (raw body first!)
// ----------------------------
app.post('/webhook', bodyParser.raw({ type: 'application/json' }), async (req, res) => {
  console.log('🔔 Webhook received!');
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error('⚠️ Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    // === Legacy Checkout flow ===
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const donorEmail = session.customer_email;
      const metadata = session.metadata || {};
      const amount = session.amount_total;
      const frequency = metadata.frequency || 'one_time';

      // Donor email
      if (process.env.SENDGRID_API_KEY && donorEmail) {
        const donorMsg = {
          to: donorEmail,
          from: 'bridgesdonations@bridgestowork.org',
          subject: `Thank you for your ${frequency === 'monthly' ? 'monthly' : 'one-time'} donation!`,
          html: `
            <p>Hi ${metadata.donor_name || 'Friend'},</p>
            <p>Thank you for your generous donation of <strong>$${(amount / 100).toFixed(2)}</strong>.</p>
            ${metadata.dedication ? `<p><strong>Dedication:</strong> ${metadata.dedication}</p>` : ''}
            <p>We truly appreciate your support.</p>
            <p>– The Bridges to Work Team</p>
          `,
          ...(isDev && { mailSettings: { sandboxMode: { enable: true } } })
        };
        try { await sgMail.send(donorMsg); }
        catch (err) { console.error('❌ Donor email failed:', err.response?.body || err.message); }
      }

      // Internal email
      if (process.env.SENDGRID_API_KEY && process.env.INTERNAL_EMAILS) {
        const internalMsg = {
          to: process.env.INTERNAL_EMAILS.split(',').map(s => s.trim()).filter(Boolean),
          from: 'bridgesdonations@bridgestowork.org',
          subject: `New Donation via Stripe: $${(amount / 100).toFixed(2)} from ${metadata.donor_name || 'Unknown'}`,
          html: `
            <p><strong>Amount:</strong> $${(amount / 100).toFixed(2)}</p>
            <p><strong>Frequency:</strong> ${frequency}</p>
            <p><strong>Name:</strong> ${metadata.donor_name || 'N/A'}</p>
            <p><strong>Email:</strong> ${donorEmail || 'N/A'}</p>
            <p><strong>Phone:</strong> ${metadata.phone || 'N/A'}</p>
            <p><strong>Address:</strong> ${metadata.address || ''}, ${metadata.city || ''}, ${metadata.state || ''}, ${metadata.zip || ''}</p>
            ${metadata.dedication ? `<p><strong>Dedication:</strong> ${metadata.dedication}</p>` : ''}
            ${metadata.notifyEmail ? `<p><strong>Acknowledgement Email To:</strong> ${metadata.notifyEmail}</p>` : ''}
            <p><strong>Subscribed to Newsletter:</strong> ${metadata.subscribeToNewsletter === 'Yes' ? 'Yes' : 'No'}</p>
          `,
          ...(isDev && { mailSettings: { sandboxMode: { enable: true } } })
        };
        try { await sgMail.send(internalMsg); }
        catch (err) { console.error('❌ Internal email failed:', err.response?.body || err.message); }
      }
    }

    // === New Inline Flow: One-time PI success ===
    if (event.type === 'payment_intent.succeeded') {
      const pi = event.data.object;

      // If this PI belongs to a subscription invoice, skip here (we'll email on invoice.payment_succeeded)
      if (pi.invoice) {
        return res.status(200).send();
      }

      const amount = pi.amount; // cents
      const donorEmail = pi.receipt_email || null;
      const md = pi.metadata || {};

      if (process.env.SENDGRID_API_KEY && donorEmail) {
        const donorMsg = {
          to: donorEmail,
          from: 'bridgesdonations@bridgestowork.org',
          subject: `Thank you for your donation!`,
          html: `
            <p>Hi ${md.donor_name || 'Friend'},</p>
            <p>Thank you for your generous donation of <strong>$${(amount / 100).toFixed(2)}</strong>.</p>
            ${md.dedication ? `<p><strong>Dedication:</strong> ${md.dedication}</p>` : ''}
            <p>We truly appreciate your support.</p>
            <p>– The Bridges to Work Team</p>
          `,
          ...(isDev && { mailSettings: { sandboxMode: { enable: true } } })
        };
        try { await sgMail.send(donorMsg); }
        catch (err) { console.error('❌ Donor email (PI) failed:', err.response?.body || err.message); }
      }

      if (process.env.SENDGRID_API_KEY && process.env.INTERNAL_EMAILS) {
        const internalMsg = {
          to: process.env.INTERNAL_EMAILS.split(',').map(s => s.trim()).filter(Boolean),
          from: 'bridgesdonations@bridgestowork.org',
          subject: `New Donation: $${(amount / 100).toFixed(2)} from ${md.donor_name || 'Unknown'}`,
          html: `
            <p><strong>Amount:</strong> $${(amount / 100).toFixed(2)}</p>
            <p><strong>Frequency:</strong> one_time</p>
            <p><strong>Name:</strong> ${md.donor_name || 'N/A'}</p>
            <p><strong>Email:</strong> ${donorEmail || 'N/A'}</p>
            <p><strong>Phone:</strong> ${md.phone || 'N/A'}</p>
            <p><strong>Address:</strong> ${md.address || ''}, ${md.city || ''}, ${md.state || ''}, ${md.zip || ''}</p>
            ${md.dedication ? `<p><strong>Dedication:</strong> ${md.dedication}</p>` : ''}
            ${md.notifyEmail ? `<p><strong>Acknowledgement Email To:</strong> ${md.notifyEmail}</p>` : ''}
            <p><strong>Subscribed to Newsletter:</strong> ${md.subscribeToNewsletter === 'Yes' ? 'Yes' : 'No'}</p>
          `,
          ...(isDev && { mailSettings: { sandboxMode: { enable: true } } })
        };
        try { await sgMail.send(internalMsg); }
        catch (err) { console.error('❌ Internal email (PI) failed:', err.response?.body || err.message); }
      }
    }

    // === New Inline Flow: Monthly invoices (first & renewals) ===
    if (event.type === 'invoice.payment_succeeded') {
      const invoice = event.data.object;
      const amount = invoice.amount_paid; // cents
      let donorEmail = invoice.customer_email || null;
      let md = {};

      try {
        if (invoice.subscription) {
          const sub = await stripe.subscriptions.retrieve(invoice.subscription);
          md = sub.metadata || {};
          if (!donorEmail && sub.customer) {
            const customer = await stripe.customers.retrieve(sub.customer);
            donorEmail = customer.email || donorEmail;
          }
        }
      } catch (e) {
        console.warn('⚠️ Could not expand subscription/customer for invoice:', e.message);
      }

      if (process.env.SENDGRID_API_KEY && donorEmail) {
        const donorMsg = {
          to: donorEmail,
          from: 'bridgesdonations@bridgestowork.org',
          subject: `Thank you for your monthly donation!`,
          html: `
            <p>Hi ${md.donor_name || 'Friend'},</p>
            <p>We received your monthly donation of <strong>$${(amount / 100).toFixed(2)}</strong>. Thank you!</p>
            ${md.dedication ? `<p><strong>Dedication:</strong> ${md.dedication}</p>` : ''}
            <p>– The Bridges to Work Team</p>
          `,
          ...(isDev && { mailSettings: { sandboxMode: { enable: true } } })
        };
        try { await sgMail.send(donorMsg); }
        catch (err) { console.error('❌ Donor email (invoice) failed:', err.response?.body || err.message); }
      }

      if (process.env.SENDGRID_API_KEY && process.env.INTERNAL_EMAILS) {
        const internalMsg = {
          to: process.env.INTERNAL_EMAILS.split(',').map(s => s.trim()).filter(Boolean),
          from: 'bridgesdonations@bridgestowork.org',
          subject: `Monthly Donation Received: $${(amount / 100).toFixed(2)} from ${md.donor_name || 'Unknown'}`,
          html: `
            <p><strong>Amount:</strong> $${(amount / 100).toFixed(2)}</p>
            <p><strong>Frequency:</strong> monthly</p>
            <p><strong>Name:</strong> ${md.donor_name || 'N/A'}</p>
            <p><strong>Email:</strong> ${donorEmail || 'N/A'}</p>
            <p><strong>Phone:</strong> ${md.phone || 'N/A'}</p>
            <p><strong>Address:</strong> ${md.address || ''}, ${md.city || ''}, ${md.state || ''}, ${md.zip || ''}</p>
            ${md.dedication ? `<p><strong>Dedication:</strong> ${md.dedication}</p>` : ''}
            ${md.notifyEmail ? `<p><strong>Acknowledgement Email To:</strong> ${md.notifyEmail}</p>` : ''}
            <p><strong>Subscribed to Newsletter:</strong> ${md.subscribeToNewsletter === 'Yes' ? 'Yes' : 'No'}</p>
          `,
          ...(isDev && { mailSettings: { sandboxMode: { enable: true } } })
        };
        try { await sgMail.send(internalMsg); }
        catch (err) { console.error('❌ Internal email (invoice) failed:', err.response?.body || err.message); }
      }
    }

    res.status(200).send();
  } catch (e) {
    console.error('Webhook handler error:', e);
    res.status(500).send();
  }
});

// ----------------------------------
// CORS with preflight + logging
// ----------------------------------
const allowedOrigins = [
  'https://gray-bay-02034850f.2.azurestaticapps.net',      // prod SWA
  'https://donate.bridgestowork.org',                      // prod custom
  'https://gentle-water-04760d20f.1.azurestaticapps.net',  // TEST SWA
  'http://localhost:8080',
  'http://127.0.0.1:8080',
  'http://localhost:8081',
  'http://127.0.0.1:8081',
  'http://localhost:5500'
];

// Let cors library dynamically mirror request headers on preflight
function corsOptionsDelegate(req, callback) {
  const origin = req.header('Origin');
  const isAllowed = !origin || allowedOrigins.includes(origin);
  callback(null, {
    origin: isAllowed,                    // true to reflect the Origin (or false to block)
    methods: ['GET','HEAD','PUT','PATCH','POST','DELETE','OPTIONS'],
    // IMPORTANT: do NOT hardcode allowedHeaders; let cors mirror Access-Control-Request-Headers
    optionsSuccessStatus: 204
  });
}

app.use(cors(corsOptionsDelegate));
app.options('*', cors(corsOptionsDelegate));  // handle all preflights

// (optional) quick logger so you can see OPTIONS hit the app
app.use((req, _res, next) => {
  console.log(`${req.method} ${req.path}  ← Origin: ${req.headers.origin || 'n/a'}`);
  next();
});

app.use(express.json());


// --- Health check ---
app.get('/', (req, res) => {
  res.send('Stripe donation server is running!');
});


// -------------------------------------
// 3) Legacy: Create Checkout session
// -------------------------------------
app.post('/create-checkout-session', async (req, res) => {
  const { amount, frequency, donorInfo } = req.body;

  try {
    const amountDollars = (amount / 100).toFixed(2);
    const donorName = encodeURIComponent(`${donorInfo.firstName} ${donorInfo.lastName}`);

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: frequency === 'monthly' ? 'subscription' : 'payment',
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: frequency === 'monthly' ? 'Monthly Donation' : 'One-Time Donation',
              description: donorInfo?.dedicationText || undefined,
            },
            unit_amount: amount,
            ...(frequency === 'monthly' && { recurring: { interval: 'month' } }),
          },
          quantity: 1,
        },
      ],
      customer_email: donorInfo?.donorEmail,
      success_url: `${FRONTEND_BASE_URL}/thank-you.html?name=${donorName}&amount=${amountDollars}`,
      cancel_url: `${FRONTEND_BASE_URL}/donation-cancelled`,
      metadata: {
        donor_name: `${donorInfo.firstName} ${donorInfo.lastName}`,
        phone: donorInfo.phone || '',
        address: donorInfo.address1 || '',
        city: donorInfo.city || '',
        state: donorInfo.state || '',
        zip: donorInfo.zip || '',
        dedication: donorInfo.dedicationText || '',
        notifyEmail: donorInfo.notifyEmail || '',
        subscribeToNewsletter: donorInfo.subscribeToNewsletter ? 'Yes' : 'No',
        frequency: frequency === 'monthly' ? 'monthly' : 'one_time'
      }
    });

    res.json({ id: session.id, url: session.url });
  } catch (err) {
    console.error('Stripe error:', err);
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------
// 4) New Inline Elements: One-time PaymentIntent
// -------------------------------------------------------
app.post('/create-payment-intent', async (req, res) => {
  try {
    const {
      amountCents,               // final amount in cents (if provided)
      currency = 'usd',
      donorEmail,
      donorName,
      coverFees = false,
      metadata = {}
    } = req.body;

    // Prefer recomputing from base on server (prevents client tampering)
    const base = Number(metadata.base_amount_cents || 0);
    const totalCents = base > 0
      ? computeGrossCents(base, { coverFees })
      : Number(amountCents);

    const pi = await stripe.paymentIntents.create({
      amount: totalCents,
      currency,
      automatic_payment_methods: { enabled: true },
      receipt_email: donorEmail,
      metadata: {
        donor_name: donorName || '',
        phone: metadata.phone || '',
        address: metadata.address1 || '',
        city: metadata.city || '',
        state: metadata.state || '',
        zip: metadata.zip || '',
        dedication: metadata.dedication_text || '',
        notifyEmail: metadata.notify_email || '',
        subscribeToNewsletter: String(metadata.newsletter_opt_in) === 'true' ? 'Yes' : 'No',
        frequency: 'one_time',
        ...metadata
      }
    });

    res.json({ clientSecret: pi.client_secret });
  } catch (err) {
    console.error('create-payment-intent error:', err);
    res.status(400).json({ error: { message: err.message } });
  }
});

// -------------------------------------------------------
// 5) New Inline Elements: SetupIntent (monthly start)
// -------------------------------------------------------
app.post('/create-setup-intent', async (req, res) => {
  try {
    const { donorEmail } = req.body;

    const customer = await stripe.customers.create({ email: donorEmail });

    const si = await stripe.setupIntents.create({
      customer: customer.id,
      payment_method_types: ['card', 'link', 'us_bank_account'] // tailor as needed
    });

    res.json({ clientSecret: si.client_secret, customerId: customer.id });
  } catch (err) {
    console.error('create-setup-intent error:', err);
    res.status(400).json({ error: { message: err.message } });
  }
});

// -------------------------------------------------------
// 6) New Inline Elements: Create Subscription (monthly)
// -------------------------------------------------------
app.post('/create-subscription', async (req, res) => {
  try {
    const {
      customerId,
      paymentMethodId,
      amountCents,                  // e.g., 2000 for $20
      currency = 'usd',
      interval = 'month',
      metadata = {}
    } = req.body;

    // Attach PM & set default
    await stripe.paymentMethods.attach(paymentMethodId, { customer: customerId });
    await stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: paymentMethodId }
    });

    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{
        price_data: {
          currency,
          product_data: { name: 'Monthly Donation' },
          recurring: { interval },
          unit_amount: Number(amountCents)
        }
      }],
      metadata: {
        frequency: 'monthly',
        donor_name: `${metadata.first_name || ''} ${metadata.last_name || ''}`.trim(),
        phone: metadata.phone || '',
        address: metadata.address1 || '',
        city: metadata.city || '',
        state: metadata.state || '',
        zip: metadata.zip || '',
        dedication: metadata.dedication_text || '',
        notifyEmail: metadata.notify_email || '',
        subscribeToNewsletter: String(metadata.newsletter_opt_in) === 'true' ? 'Yes' : 'No',
        ...metadata
      },
      expand: ['latest_invoice.payment_intent']
    });

    res.json({ subscriptionId: subscription.id, status: subscription.status });
  } catch (err) {
    console.error('create-subscription error:', err);
    res.status(400).json({ error: { message: err.message } });
  }
});

// --- Start server ---
app.listen(PORT, () => {
  console.log(`✅ Stripe donation server is running on port ${PORT}`);
});
