'use strict';

var frameService = require('../../lib/frame-service/external');
var BraintreeError = require('../../lib/error');
var once = require('../../lib/once');
var VERSION = require('package.version');
var constants = require('../shared/constants');
var INTEGRATION_TIMEOUT_MS = require('../../lib/constants').INTEGRATION_TIMEOUT_MS;
var analytics = require('../../lib/analytics');
var methods = require('../../lib/methods');
var deferred = require('../../lib/deferred');
var getCountry = require('../shared/get-country');
var convertMethodsToError = require('../../lib/convert-methods-to-error');
var querystring = require('../../lib/querystring');

/**
 * @typedef {object} PayPal~tokenizePayload
 * @property {string} nonce The payment method nonce.
 * @property {string} type The payment method type, always `PayPalAccount`.
 * @property {object} details Additional PayPal account details.
 * @property {string} details.email User's email address.
 * @property {string} details.payerId User's payer ID, the unique identifier for each PayPal account.
 * @property {string} details.firstName User's given name.
 * @property {string} details.lastName User's surname.
 * @property {?string} details.countryCode User's 2 character country code.
 * @property {?string} details.phone User's phone number (e.g. 555-867-5309).
 * @property {?object} details.shippingAddress User's shipping address details, only available if shipping address is enabled.
 * @property {string} details.shippingAddress.recipientName Recipient of postage.
 * @property {string} details.shippingAddress.line1 Street number and name.
 * @property {string} details.shippingAddress.line2 Extended address.
 * @property {string} details.shippingAddress.city City or locality.
 * @property {string} details.shippingAddress.state State or region.
 * @property {string} details.shippingAddress.postalCode Postal code.
 * @property {string} details.shippingAddress.countryCode 2 character country code (e.g. US).
 */

/**
 * @typedef {object} PayPal~tokenizeReturn
 * @property {Function} close A handle to close the PayPal checkout flow.
 */

/**
 * @class
 * @param {object} options see {@link module:braintree-web/paypal.create|paypal.create}
 * @classdesc This class represents a PayPal component. Instances of this class have methods for launching auth dialogs and other programmatic interactions with the PayPal component.
 */
function PayPal(options) {
  this._client = options.client;
  this._assetsUrl = options.client.getConfiguration().gatewayConfiguration.paypal.assetsUrl + '/web/' + VERSION;
  this._authorizationInProgress = false;
}

PayPal.prototype._initialize = function (callback) {
  var client = this._client;
  var failureTimeout = setTimeout(function () {
    analytics.sendEvent(client, 'web.paypal.load.timed-out');
  }, INTEGRATION_TIMEOUT_MS);

  frameService.create({
    name: constants.LANDING_FRAME_NAME,
    dispatchFrameUrl: this._assetsUrl + '/html/dispatch-frame@DOT_MIN.html',
    openFrameUrl: this._assetsUrl + '/html/paypal-landing-frame@DOT_MIN.html'
  }, function (service) {
    this._frameService = service;
    clearTimeout(failureTimeout);
    analytics.sendEvent(client, 'web.paypal.load.succeeded');
    callback();
  }.bind(this));
};

/**
 * Launches the PayPal login flow and returns a nonce payload.
 * @public
 * @param {object} options All tokenization options for the PayPal component.
 * @param {string} options.flow Set to 'checkout' for one-time payment flow, or 'vault' for Vault flow.
 * @param {string} [options.intent=authorize]
 * Checkout flows only.
 * * `authorize` - Submits the transaction for authorization but not settlement.
 * * `sale` - Payment will be immediately submitted for settlement upon creating a transaction.
 * @param {boolean} [options.offerCredit=false] Offers the customer PayPal Credit if they qualify. Checkout flows only.
 * @param {string} [options.useraction]
 * Changes the call-to-action in the PayPal flow. By default the final button will show the localized
 * word for "Continue" and implies that the final amount billed is not yet known.
 *
 * Setting this option to `commit` changes the button text to "Pay Now" and page text will convey to
 * the user that billing will take place immediately.
 * @param {string|number} [options.amount] The amount of the transaction. Required when using the Checkout flow.
 * @param {string} [options.currency] The currency code of the amount, such as 'USD'. Required when using the Checkout flow.
 * @param {string} [options.displayName] The merchant name displayed inside of the PayPal lightbox; defaults to the company name on your Braintree account
 * @param {string} [options.locale=en_us] Use this option to change the language, links, and terminology used in the PayPal flow to suit the country and language of your customer.
 * @param {boolean} [options.enableShippingAddress=false] Returns a shipping address object in {@link PayPal#tokenize}.
 * @param {object} [options.shippingAddressOverride] Allows you to pass a shipping address you have already collected into the PayPal payment flow.
 * @param {string} options.shippingAddressOverride.line1 Street address.
 * @param {string} [options.shippingAddressOverride.line2] Street address (extended).
 * @param {string} options.shippingAddressOverride.city City.
 * @param {string} options.shippingAddressOverride.state State.
 * @param {string} options.shippingAddressOverride.postalCode Postal code.
 * @param {string} options.shippingAddressOverride.countryCode Country.
 * @param {string} [options.shippingAddressOverride.phone] Phone number.
 * @param {string} [options.shippingAddressOverride.recipientName] Recipient's name.
 * @param {boolean} [options.shippingAddressEditable=true] Set to false to disable user editing of the shipping address.
 * @param {string} [options.billingAgreementDescription] Use this option to set the description of the preapproved payment agreement visible to customers in their PayPal profile during Vault flows. Max 255 characters.
 * @param {callback} callback The second argument, <code>data</code>, is a {@link PayPal~tokenizePayload|tokenizePayload}.
 * @returns {PayPal~tokenizeReturn} A handle to close the PayPal checkout frame.
 */
PayPal.prototype.tokenize = function (options, callback) {
  var client = this._client;

  if (typeof callback !== 'function') {
    throw new BraintreeError({
      type: BraintreeError.types.MERCHANT,
      message: 'tokenize must include a callback function.'
    });
  }

  callback = once(deferred(callback));

  if (this._authorizationInProgress) {
    analytics.sendEvent(client, 'web.paypal.tokenization.error.already-opened');

    callback(new BraintreeError({
      type: BraintreeError.types.MERCHANT,
      message: 'Another tokenization request is active.'
    }));
  } else {
    this._authorizationInProgress = true;

    analytics.sendEvent(client, 'web.paypal.tokenization.opened');
    this._navigateFrameToAuth(options, callback);
    // This MUST happen after _navigateFrameToAuth for Metro browsers to work.
    this._frameService.open(this._createFrameServiceCallback(options, callback));
  }

  return {
    close: function () {
      analytics.sendEvent(client, 'web.paypal.tokenization.closed.by-merchant');
      this._frameService.close();
    }.bind(this)
  };
};

PayPal.prototype._createFrameServiceCallback = function (options, callback) {
  var client = this._client;

  return function (err, params) {
    this._authorizationInProgress = false;

    if (err) {
      if (err.message === constants.FRAME_CLOSED_ERROR_MESSAGE) {
        analytics.sendEvent(client, 'web.paypal.tokenization.closed.by-user');
      }
      callback(err);
    } else {
      this._tokenizePayPal(options, params, callback);
    }
  }.bind(this);
};

PayPal.prototype._tokenizePayPal = function (options, params, callback) {
  var client = this._client;

  client.request({
    endpoint: 'payment_methods/paypal_accounts',
    method: 'post',
    data: this._formatTokenizeData(options, params)
  }, function (err, response) {
    if (err) {
      analytics.sendEvent(client, 'web.paypal.tokenization.failed');
      callback(err instanceof BraintreeError ? err : new BraintreeError({
        type: BraintreeError.types.NETWORK,
        message: 'Could not tokenize user\'s PayPal account.',
        details: err
      }));
    } else {
      analytics.sendEvent(client, 'web.paypal.tokenization.success');
      callback(null, this._formatTokenizePayload(response));
    }
  }.bind(this));
};

PayPal.prototype._formatTokenizePayload = function (response) {
  var payload;
  var account = {};

  if (response.paypalAccounts) {
    account = response.paypalAccounts[0];
  }

  payload = {
    nonce: account.nonce,
    details: {},
    type: account.type
  };

  if (account.details && account.details.payerInfo) {
    payload.details = account.details.payerInfo;
  }

  return payload;
};

PayPal.prototype._formatTokenizeData = function (options, params) {
  var gatewayConfiguration = this._client.getConfiguration().gatewayConfiguration;
  var data = {
    paypalAccount: {correlationId: this._frameService._serviceId}
  };

  if (params.ba_token) {
    data.paypalAccount.billingAgreementToken = params.ba_token;
  } else {
    data.paypalAccount.paymentToken = params.paymentId;
    data.paypalAccount.payerId = params.PayerID;
    data.paypalAccount.unilateral = gatewayConfiguration.paypal.unvettedMerchant;

    if (options.hasOwnProperty('intent')) {
      data.paypalAccount.intent = options.intent;
    }
  }

  return data;
};

PayPal.prototype._navigateFrameToAuth = function (options, callback) {
  var client = this._client;
  var endpoint = 'paypal_hermes/';

  if (options.flow === 'checkout') {
    endpoint += 'create_payment_resource';
  } else if (options.flow === 'vault') {
    endpoint += 'setup_billing_agreement';
  } else {
    callback(new BraintreeError({
      type: BraintreeError.types.MERCHANT,
      message: 'PayPal flow property is invalid or missing.'
    }));
    return;
  }

  client.request({
    endpoint: endpoint,
    method: 'post',
    data: this._formatPaymentResourceData(options)
  }, function (err, response) {
    var redirectUrl;

    if (err) {
      callback(err instanceof BraintreeError ? err : new BraintreeError({
        type: BraintreeError.types.NETWORK,
        message: constants.AUTH_INIT_ERROR_MESSAGE,
        details: err
      }));
      this._frameService.close();
    } else {
      if (options.flow === 'checkout') {
        redirectUrl = response.paymentResource.redirectUrl;
      } else {
        redirectUrl = response.agreementSetup.approvalUrl;
      }

      if (options.useraction === 'commit') {
        redirectUrl = querystring.queryify(redirectUrl, {useraction: 'commit'});
      }

      this._frameService.redirect(redirectUrl);
    }
  }.bind(this));
};

PayPal.prototype._formatPaymentResourceData = function (options) {
  var key;
  var gatewayConfiguration = this._client.getConfiguration().gatewayConfiguration;
  var serviceId = this._frameService._serviceId;
  var paymentResource = {
    returnUrl: gatewayConfiguration.paypal.assetsUrl + '/web/' + VERSION + '/html/paypal-redirect-frame@DOT_MIN.html?channel=' + serviceId,
    cancelUrl: gatewayConfiguration.paypal.assetsUrl + '/web/' + VERSION + '/html/paypal-cancel-frame@DOT_MIN.html?channel=' + serviceId,
    correlationId: serviceId,
    experienceProfile: {
      brandName: options.displayName || gatewayConfiguration.paypal.displayName,
      localeCode: getCountry(options.locale),
      noShipping: (!options.enableShippingAddress).toString(),
      addressOverride: options.shippingAddressEditable === false
    }
  };

  if (options.flow === 'checkout') {
    paymentResource.amount = parseFloat(options.amount).toFixed(2);
    paymentResource.currencyIsoCode = options.currency;
    paymentResource.offerPaypalCredit = options.offerCredit === true;

    if (options.hasOwnProperty('intent')) {
      paymentResource.intent = options.intent;
    }

    for (key in options.shippingAddressOverride) {
      if (options.shippingAddressOverride.hasOwnProperty(key)) {
        paymentResource[key] = options.shippingAddressOverride[key];
      }
    }
  } else {
    paymentResource.shippingAddress = options.shippingAddressOverride;

    if (options.billingAgreementDescription) {
      paymentResource.description = options.billingAgreementDescription;
    }
  }

  return paymentResource;
};

/**
 * Cleanly tear down anything set up by {@link module:braintree-web/paypal.create|create}.
 * @public
 * @param {callback} [callback] Called once teardown is complete. No data is returned if teardown completes successfully.
 * @returns {void}
 */
PayPal.prototype.teardown = function (callback) {
  this._frameService.teardown();

  convertMethodsToError(this, methods(PayPal.prototype));

  analytics.sendEvent(this._client, 'web.paypal.teardown-completed');

  if (typeof callback === 'function') {
    callback = deferred(callback);
    callback();
  }
};

module.exports = PayPal;