/**
 * FedEx REST API Service
 * https://developer.fedex.com/api/en-us/home.html
 */

const FEDEX_API_BASE = process.env.FEDEX_MODE === 'production'
  ? 'https://apis.fedex.com'
  : 'https://apis-sandbox.fedex.com';

// Token cache - Ship/Rate/Address (Project 1)
let cachedToken = null;
let tokenExpiresAt = 0;

// Token cache - Track (Project 2: Basic Integrated Visibility)
let cachedTrackToken = null;
let trackTokenExpiresAt = 0;

/**
 * Get FedEx OAuth 2.0 access token (with caching)
 * @param {'default'|'track'} project - Which project credentials to use
 */
async function getAccessToken(project = 'default') {
  if (project === 'track') {
    // Track API uses separate credentials (Project 2)
    if (cachedTrackToken && Date.now() < trackTokenExpiresAt - 60000) {
      return cachedTrackToken;
    }

    const apiKey = process.env.FEDEX_TRACK_API_KEY || process.env.FEDEX_API_KEY;
    const secretKey = process.env.FEDEX_TRACK_SECRET_KEY || process.env.FEDEX_SECRET_KEY;

    console.log('\n=== [FedEx] Track Authentication ===');
    console.log('Using Track-specific key:', !!process.env.FEDEX_TRACK_API_KEY);
    console.log('API Key loaded:', apiKey ? `${apiKey.substring(0, 10)}...` : 'NOT SET');

    if (!apiKey || !secretKey) {
      throw new Error('FedEx Track credentials not configured. Set FEDEX_TRACK_API_KEY and FEDEX_TRACK_SECRET_KEY.');
    }

    const response = await fetch(`${FEDEX_API_BASE}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: apiKey,
        client_secret: secretKey,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('[FedEx] Track auth failed:', error);
      throw new Error(`FedEx Track auth failed: ${error}`);
    }

    const data = await response.json();
    cachedTrackToken = data.access_token;
    trackTokenExpiresAt = Date.now() + (data.expires_in * 1000);

    console.log('[FedEx] Track token acquired, expires in:', data.expires_in, 'seconds');
    return cachedTrackToken;
  }

  // Default: Ship/Rate/Address (Project 1)
  if (cachedToken && Date.now() < tokenExpiresAt - 60000) {
    return cachedToken;
  }

  const apiKey = process.env.FEDEX_API_KEY;
  const secretKey = process.env.FEDEX_SECRET_KEY;

  console.log('\n=== [FedEx] Authentication ===');
  console.log('FEDEX_MODE:', process.env.FEDEX_MODE);
  console.log('API Base:', FEDEX_API_BASE);
  console.log('API Key loaded:', apiKey ? `${apiKey.substring(0, 10)}...` : 'NOT SET');
  console.log('Secret Key loaded:', secretKey ? `${secretKey.substring(0, 10)}...` : 'NOT SET');

  if (!apiKey || !secretKey) {
    throw new Error('FedEx credentials not configured. Set FEDEX_API_KEY and FEDEX_SECRET_KEY.');
  }

  const response = await fetch(`${FEDEX_API_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: apiKey,
      client_secret: secretKey,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    console.error('[FedEx] Auth failed:', error);
    throw new Error(`FedEx auth failed: ${error}`);
  }

  const data = await response.json();
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in * 1000);

  console.log('[FedEx] Token acquired, expires in:', data.expires_in, 'seconds');
  return cachedToken;
}

/**
 * Get shipper address from environment variables
 */
function getShipperInfo() {
  return {
    address: {
      streetLines: [process.env.FEDEX_SHIPPER_STREET || '123 Warehouse St'],
      city: process.env.FEDEX_SHIPPER_CITY || 'Seoul',
      stateOrProvinceCode: process.env.FEDEX_SHIPPER_STATE || 'SE',
      postalCode: process.env.FEDEX_SHIPPER_POSTAL || '06100',
      countryCode: process.env.FEDEX_SHIPPER_COUNTRY || 'KR',
    },
    contact: {
      personName: process.env.FEDEX_SHIPPER_NAME || 'Datepalm Bay',
      phoneNumber: process.env.FEDEX_SHIPPER_PHONE || '02-1234-5678',
      companyName: 'Datepalm Bay',
    },
  };
}

/**
 * Get shipping rate quotes
 * @param {Object} params
 * @param {Object} params.recipient - Recipient address { postalCode, countryCode, city?, stateOrProvinceCode? }
 * @param {Array} params.packages - Array of { weight (kg), length (cm), width (cm), height (cm) }
 * @param {string} [params.serviceType] - Optional specific service type to quote
 */
async function getRates({ recipient, packages, serviceType }) {
  const accessToken = await getAccessToken();
  const accountNumber = process.env.FEDEX_ACCOUNT_NUMBER;

  if (!accountNumber) {
    throw new Error('FEDEX_ACCOUNT_NUMBER not configured');
  }

  const shipper = getShipperInfo();

  const payload = {
    accountNumber: { value: accountNumber },
    requestedShipment: {
      shipper: { address: shipper.address },
      recipient: {
        address: {
          postalCode: recipient.postalCode,
          countryCode: recipient.countryCode,
          ...(recipient.city && { city: recipient.city }),
          ...(recipient.stateOrProvinceCode && { stateOrProvinceCode: recipient.stateOrProvinceCode }),
        },
      },
      pickupType: 'DROPOFF_AT_FEDEX_LOCATION',
      rateRequestType: ['ACCOUNT', 'LIST'],
      requestedPackageLineItems: packages.map((pkg) => ({
        weight: { units: 'KG', value: pkg.weight },
        dimensions: {
          length: pkg.length,
          width: pkg.width,
          height: pkg.height,
          units: 'CM',
        },
      })),
      ...(serviceType && { serviceType }),
    },
  };

  console.log('\n=== [FedEx] Getting Rates ===');
  console.log('To:', recipient.countryCode, recipient.postalCode);
  console.log('Packages:', packages.length);

  const response = await fetch(`${FEDEX_API_BASE}/rate/v1/rates/quotes`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json();

  if (!response.ok) {
    console.error('[FedEx] Rate quote error:', JSON.stringify(data, null, 2));
    throw new Error(data.errors?.[0]?.message || 'Failed to get FedEx rates');
  }

  // Parse rate options
  const rateOptions = (data.output?.rateReplyDetails || []).map((detail) => {
    const shipmentRate = detail.ratedShipmentDetails?.[0];
    return {
      serviceType: detail.serviceType,
      serviceName: detail.serviceName || detail.serviceType,
      totalCharge: parseFloat(shipmentRate?.totalNetCharge || 0),
      currency: shipmentRate?.currency || 'USD',
      estimatedDeliveryDate: detail.commit?.dateDetail?.dayFormat || null,
      transitDays: detail.commit?.transitDays?.value || null,
    };
  });

  console.log('[FedEx] Rate options:', rateOptions.length);
  return rateOptions;
}

/**
 * Create shipment and generate label
 * @param {Object} params
 * @param {Object} params.recipient - Full recipient { contact: { personName, phoneNumber }, address: { streetLines, city, stateOrProvinceCode, postalCode, countryCode } }
 * @param {Array} params.packages - Array of { weight (kg), length (cm), width (cm), height (cm) }
 * @param {string} params.serviceType - FedEx service type
 * @param {string} [params.labelFormat='PDF'] - Label format (PDF, PNG, ZPLII)
 */
async function createShipment({ recipient, packages, serviceType, labelFormat = 'PDF' }) {
  const accessToken = await getAccessToken();
  const accountNumber = process.env.FEDEX_ACCOUNT_NUMBER;

  if (!accountNumber) {
    throw new Error('FEDEX_ACCOUNT_NUMBER not configured');
  }

  const shipper = getShipperInfo();

  const payload = {
    accountNumber: { value: accountNumber },
    requestedShipment: {
      shipper,
      recipients: [recipient],
      pickupType: 'DROPOFF_AT_FEDEX_LOCATION',
      serviceType,
      packagingType: 'YOUR_PACKAGING',
      shippingChargesPayment: {
        paymentType: 'SENDER',
      },
      labelSpecification: {
        imageType: labelFormat,
        labelStockType: labelFormat === 'PDF' ? 'PAPER_85X11_TOP_HALF_LABEL' : 'STOCK_4X6',
      },
      requestedPackageLineItems: packages.map((pkg, index) => ({
        sequenceNumber: index + 1,
        weight: { units: 'KG', value: pkg.weight },
        dimensions: {
          length: pkg.length,
          width: pkg.width,
          height: pkg.height,
          units: 'CM',
        },
      })),
    },
  };

  console.log('\n=== [FedEx] Creating Shipment ===');
  console.log('Service:', serviceType);
  console.log('To:', recipient.address?.countryCode, recipient.address?.postalCode);
  console.log('Packages:', packages.length);

  const response = await fetch(`${FEDEX_API_BASE}/ship/v1/shipments`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json();

  if (!response.ok) {
    console.error('[FedEx] Create shipment error:', JSON.stringify(data, null, 2));
    throw new Error(data.errors?.[0]?.message || 'Failed to create FedEx shipment');
  }

  const shipmentResult = data.output?.transactionShipments?.[0];
  const pieceResponse = shipmentResult?.pieceResponses?.[0];

  const result = {
    trackingNumber: pieceResponse?.trackingNumber || shipmentResult?.masterTrackingNumber,
    label: pieceResponse?.packageDocuments?.[0]?.encodedLabel || null,
    labelFormat,
    serviceType,
    shipmentId: shipmentResult?.shipDatestamp,
    estimatedDelivery: shipmentResult?.completedShipmentDetail?.operationalDetail?.deliveryDate || null,
  };

  console.log('[FedEx] Shipment created, tracking:', result.trackingNumber);
  return result;
}

/**
 * Track shipment by tracking number(s)
 * @param {string|string[]} trackingNumbers - One or more tracking numbers
 */
async function trackShipment(trackingNumbers) {
  const accessToken = await getAccessToken('track');

  const numbers = Array.isArray(trackingNumbers) ? trackingNumbers : [trackingNumbers];

  const payload = {
    includeDetailedScans: true,
    trackingInfo: numbers.map((num) => ({
      trackingNumberInfo: { trackingNumber: num },
    })),
  };

  console.log('\n=== [FedEx] Tracking Shipment ===');
  console.log('Tracking numbers:', numbers.join(', '));

  const response = await fetch(`${FEDEX_API_BASE}/track/v1/trackingnumbers`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json();

  if (!response.ok) {
    console.error('[FedEx] Tracking error:', JSON.stringify(data, null, 2));
    throw new Error(data.errors?.[0]?.message || 'Failed to track FedEx shipment');
  }

  // Parse tracking results
  const results = (data.output?.completeTrackResults || []).map((result) => {
    const trackResult = result.trackResults?.[0];
    return {
      trackingNumber: result.trackingNumber,
      statusDescription: trackResult?.latestStatusDetail?.description || 'Unknown',
      statusCode: trackResult?.latestStatusDetail?.code || 'UN',
      estimatedDelivery: trackResult?.estimatedDeliveryTimeWindow?.window?.ends || null,
      deliveryDate: trackResult?.actualDeliveryDetail?.actualDeliveryTimestamp || null,
      events: (trackResult?.scanEvents || []).map((event) => ({
        timestamp: event.date,
        eventType: event.eventType,
        eventDescription: event.eventDescription || event.derivedStatus,
        city: event.scanLocation?.city || '',
        stateOrProvinceCode: event.scanLocation?.stateOrProvinceCode || '',
        countryCode: event.scanLocation?.countryCode || '',
        statusCode: event.derivedStatusCode || '',
      })),
    };
  });

  console.log('[FedEx] Tracking results:', results.length);
  return results;
}

/**
 * Validate and resolve an address
 * @param {Object} address - { streetLines, city, stateOrProvinceCode, postalCode, countryCode }
 */
async function validateAddress(address) {
  const accessToken = await getAccessToken();

  const payload = {
    addressesToValidate: [
      {
        address: {
          streetLines: address.streetLines || [address.street],
          city: address.city,
          stateOrProvinceCode: address.stateOrProvinceCode,
          postalCode: address.postalCode,
          countryCode: address.countryCode,
        },
      },
    ],
  };

  console.log('\n=== [FedEx] Validating Address ===');
  console.log('Address:', address.city, address.countryCode);

  const response = await fetch(`${FEDEX_API_BASE}/address/v1/addresses/resolve`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json();

  if (!response.ok) {
    console.error('[FedEx] Address validation error:', JSON.stringify(data, null, 2));
    throw new Error(data.errors?.[0]?.message || 'Failed to validate address');
  }

  const resolved = data.output?.resolvedAddresses?.[0];

  return {
    isValid: resolved?.classification !== 'UNKNOWN',
    classification: resolved?.classification || 'UNKNOWN', // RESIDENTIAL, BUSINESS, MIXED, UNKNOWN
    resolvedAddress: resolved?.streetLinesToken ? {
      streetLines: resolved.streetLinesToken,
      city: resolved.city,
      stateOrProvinceCode: resolved.stateOrProvinceCode,
      postalCode: resolved.postalCode,
      countryCode: resolved.countryCode,
    } : null,
    attributes: resolved?.attributes || {},
  };
}

/**
 * Schedule a FedEx pickup
 * @param {Object} params
 * @param {Object} params.pickupAddress - Pickup location address
 * @param {Object} params.pickupContact - Contact at pickup location { personName, phoneNumber, companyName }
 * @param {string} params.readyDate - Ready date (YYYY-MM-DD)
 * @param {string} params.readyTime - Ready time (HH:MM:SS)
 * @param {string} params.closeTime - Latest pickup time (HH:MM:SS)
 * @param {string} params.pickupType - SAME_DAY or FUTURE_DAY
 * @param {number} params.totalWeight - Total weight in KG
 * @param {number} params.packageCount - Number of packages
 * @param {string} [params.remarks] - Special instructions
 */
async function schedulePickup({ pickupAddress, pickupContact, readyDate, readyTime, closeTime, pickupType = 'FUTURE_DAY', totalWeight, packageCount, remarks }) {
  const accessToken = await getAccessToken();
  const accountNumber = process.env.FEDEX_ACCOUNT_NUMBER;

  if (!accountNumber) {
    throw new Error('FEDEX_ACCOUNT_NUMBER not configured');
  }

  const payload = {
    associatedAccountNumber: { value: accountNumber },
    originDetail: {
      pickupAddressDetail: {
        address: {
          streetLines: pickupAddress?.streetLines || [process.env.FEDEX_SHIPPER_STREET || '123 Warehouse St'],
          city: pickupAddress?.city || process.env.FEDEX_SHIPPER_CITY || 'Seoul',
          stateOrProvinceCode: pickupAddress?.stateOrProvinceCode || process.env.FEDEX_SHIPPER_STATE || 'SE',
          postalCode: pickupAddress?.postalCode || process.env.FEDEX_SHIPPER_POSTAL || '06100',
          countryCode: pickupAddress?.countryCode || process.env.FEDEX_SHIPPER_COUNTRY || 'KR',
        },
        contact: {
          personName: pickupContact?.personName || process.env.FEDEX_SHIPPER_NAME || 'Datepalm Bay',
          phoneNumber: pickupContact?.phoneNumber || process.env.FEDEX_SHIPPER_PHONE || '02-1234-5678',
          companyName: pickupContact?.companyName || 'Datepalm Bay',
        },
      },
      readyDateTimestamp: `${readyDate}T${readyTime}`,
      customerCloseTime: closeTime,
      pickupDateType: pickupType,
    },
    totalWeight: { units: 'KG', value: totalWeight || 1.0 },
    packageCount: packageCount || 1,
    ...(remarks && { remarks }),
  };

  console.log('\n=== [FedEx] Scheduling Pickup ===');
  console.log('Date:', readyDate);
  console.log('Ready:', readyTime, '~ Close:', closeTime);
  console.log('Packages:', packageCount, 'Weight:', totalWeight, 'kg');

  const response = await fetch(`${FEDEX_API_BASE}/pickup/v1/pickups`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json();

  if (!response.ok) {
    console.error('[FedEx] Pickup schedule error:', JSON.stringify(data, null, 2));
    throw new Error(data.errors?.[0]?.message || 'Failed to schedule pickup');
  }

  const result = {
    pickupConfirmationCode: data.output?.pickupConfirmationCode || null,
    pickupDate: readyDate,
    readyTime,
    closeTime,
    location: data.output?.location || null,
  };

  console.log('[FedEx] Pickup scheduled, confirmation:', result.pickupConfirmationCode);
  return result;
}

/**
 * Cancel a scheduled FedEx pickup
 * @param {string} pickupConfirmationCode - Pickup confirmation code
 * @param {string} scheduledDate - Scheduled date (YYYY-MM-DD)
 */
async function cancelPickup(pickupConfirmationCode, scheduledDate) {
  const accessToken = await getAccessToken();
  const accountNumber = process.env.FEDEX_ACCOUNT_NUMBER;

  const payload = {
    associatedAccountNumber: { value: accountNumber },
    pickupConfirmationCode,
    scheduledDate,
  };

  console.log('\n=== [FedEx] Cancelling Pickup ===');
  console.log('Confirmation:', pickupConfirmationCode);

  const response = await fetch(`${FEDEX_API_BASE}/pickup/v1/pickups/cancel`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json();

  if (!response.ok) {
    console.error('[FedEx] Pickup cancel error:', JSON.stringify(data, null, 2));
    throw new Error(data.errors?.[0]?.message || 'Failed to cancel pickup');
  }

  console.log('[FedEx] Pickup cancelled:', pickupConfirmationCode);
  return { cancelled: true, pickupConfirmationCode };
}

// ═══════════════════════════════════════════════
// Global Trade API
// ═══════════════════════════════════════════════

/**
 * Retrieve regulatory documents and advisories for international shipment
 * @param {Object} params
 * @param {Object} params.originAddress - { countryCode, postalCode, stateOrProvinceCode? }
 * @param {Object} params.destinationAddress - { countryCode, postalCode, stateOrProvinceCode? }
 * @param {string} [params.carrierCode='FDXE'] - FedEx carrier code (FDXE=Express, FDXG=Ground)
 * @param {Object} [params.totalWeight] - { units: 'KG'|'LB', value: number }
 * @param {Array} [params.commodities] - Array of { description, harmonizedCode, weight, quantity, customsValue, countryOfManufacture }
 * @param {string} [params.shipDate] - Planned ship date (YYYY-MM-DD)
 */
async function retrieveRegulatoryDocuments({ originAddress, destinationAddress, carrierCode = 'FDXE', totalWeight, commodities, shipDate }) {
  const accessToken = await getAccessToken();

  const payload = {
    originAddress: {
      countryCode: originAddress?.countryCode || process.env.FEDEX_SHIPPER_COUNTRY || 'KR',
      postalCode: originAddress?.postalCode || process.env.FEDEX_SHIPPER_POSTAL || '07590',
      ...(originAddress?.stateOrProvinceCode && { stateOrProvinceCode: originAddress.stateOrProvinceCode }),
    },
    destinationAddress: {
      countryCode: destinationAddress.countryCode,
      postalCode: destinationAddress.postalCode,
      ...(destinationAddress.stateOrProvinceCode && { stateOrProvinceCode: destinationAddress.stateOrProvinceCode }),
    },
    carrierCode,
    totalWeight: totalWeight || { units: 'KG', value: 1.0 },
    ...(shipDate && { shipDate }),
    customsClearanceDetail: {
      customsValue: { amount: '', currency: '' },
      commodities: (commodities?.length > 0)
        ? commodities.map((item) => ({
            description: item.description || '',
            ...(item.harmonizedCode && { harmonizedCode: item.harmonizedCode }),
            weight: item.weight || { units: 'KG', value: 1.0 },
            quantity: item.quantity || 1,
            customsValue: item.customsValue || { amount: 0, currency: 'USD' },
            countryOfManufacture: item.countryOfManufacture || 'KR',
          }))
        : [{ harmonizedCode: '080410' }],
    },
  };

  console.log('\n=== [FedEx] Retrieving Regulatory Documents ===');
  console.log('Origin:', payload.originAddress.countryCode, payload.originAddress.postalCode);
  console.log('Destination:', destinationAddress.countryCode, destinationAddress.postalCode);
  console.log('Carrier:', carrierCode);

  const response = await fetch(`${FEDEX_API_BASE}/globaltrade/v1/shipments/regulatorydetails/retrieve`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'X-locale': 'en_US',
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json();

  if (!response.ok) {
    console.error('[FedEx] Regulatory docs error:', JSON.stringify(data, null, 2));
    throw new Error(data.errors?.[0]?.message || 'Failed to retrieve regulatory documents');
  }

  const output = data.output || {};

  const result = {
    regulatoryDocuments: (output.regulatoryDocuments || []).map((doc) => ({
      documentType: doc.documentType,
      documentDescription: doc.documentDescription || doc.documentType,
      required: doc.required || false,
      generationMethod: doc.generationMethod || 'MANUAL',
      url: doc.url || null,
    })),
    advisories: (output.advisories || []).map((adv) => ({
      code: adv.code,
      description: adv.description,
      type: adv.type || 'INFORMATION',
    })),
    prohibitions: output.prohibitions || [],
    eeiRequired: output.eeiRequired || false,
  };

  console.log('[FedEx] Regulatory documents:', result.regulatoryDocuments.length);
  console.log('[FedEx] Advisories:', result.advisories.length);
  console.log('[FedEx] EEI Required:', result.eeiRequired);
  return result;
}

// ═══════════════════════════════════════════════
// Trade Documents Upload API
// ═══════════════════════════════════════════════

/**
 * Upload base64-encoded trade documents (up to 5)
 * @param {Object} params
 * @param {string} [params.workflowName='ETDPreShipment'] - 'ETDPreShipment' or 'ETDPostShipment'
 * @param {string} [params.carrierCode='FDXE'] - FedEx carrier code
 * @param {string} params.originCountryCode - Origin country code
 * @param {string} params.destinationCountryCode - Destination country code
 * @param {Array} params.documents - Array of { fileName, contentType, shipDocumentType, encodedContent (base64) }
 *   shipDocumentType: COMMERCIAL_INVOICE | CERTIFICATE_OF_ORIGIN | PRO_FORMA_INVOICE |
 *                     USMCA_CERTIFICATION_OF_ORIGIN | USMCA_COMMERCIAL_INVOICE_CERTIFICATION_OF_ORIGIN |
 *                     ETD_LABEL | OTHER
 * @param {string} [params.trackingNumber] - Required for post-shipment upload
 * @param {string} [params.shipmentDate] - Required for post-shipment (YYYY-MM-DD)
 */
async function uploadTradeDocuments({ workflowName = 'ETDPreshipment', carrierCode = 'FDXE', originCountryCode, destinationCountryCode, documents, trackingNumber, shipmentDate }) {
  const accessToken = await getAccessToken();

  console.log('\n=== [FedEx] Uploading Trade Documents ===');
  console.log('Workflow:', workflowName);
  console.log('Documents:', documents.length);
  console.log('Route:', originCountryCode || 'KR', '→', destinationCountryCode);

  const docApiBase = process.env.FEDEX_MODE === 'production'
    ? 'https://documentapi.prod.fedex.com'
    : 'https://documentapitest.prod.fedex.com/sandbox';

  const results = [];

  for (const doc of documents) {
    const fileName = doc.fileName || 'document.pdf';
    const fileContentType = doc.contentType || 'application/pdf';

    const documentJson = {
      workflowName,
      carrierCode,
      name: fileName,
      contentType: fileContentType,
      meta: {
        shipDocumentType: doc.shipDocumentType || 'COMMERCIAL_INVOICE',
        originCountryCode: originCountryCode || process.env.FEDEX_SHIPPER_COUNTRY || 'KR',
        destinationCountryCode,
        ...(trackingNumber && { trackingNumber }),
        ...(shipmentDate && { shipmentDate }),
      },
    };

    // Decode base64 to binary buffer for attachment
    const fileBuffer = Buffer.from(doc.encodedContent, 'base64');

    // Use native FormData API (Node 18+)
    const formData = new FormData();
    formData.append('document', JSON.stringify(documentJson));
    formData.append('attachment', new Blob([fileBuffer], { type: fileContentType }), fileName);

    console.log(`  Uploading: ${fileName} (${doc.shipDocumentType || 'COMMERCIAL_INVOICE'})`);

    const response = await fetch(`${docApiBase}/documents/v1/etds/upload`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'X-locale': 'en_US',
      },
      body: formData,
    });

    let data;
    const responseText = await response.text();
    try {
      data = JSON.parse(responseText);
    } catch {
      data = { rawResponse: responseText };
    }

    if (!response.ok) {
      console.error(`[FedEx] Document upload error (${fileName}):`, JSON.stringify(data, null, 2));
      results.push({
        fileName,
        documentType: doc.shipDocumentType || 'COMMERCIAL_INVOICE',
        status: 'FAILED',
        error: data.errors?.message || data.errors?.[0]?.message || 'Upload failed',
      });
      continue;
    }

    const output = data.output || data;
    const meta = output.meta || output;
    results.push({
      docId: meta.docId || output.docId || null,
      folderId: meta.folderId || null,
      documentType: meta.documentType || doc.shipDocumentType || 'COMMERCIAL_INVOICE',
      fileName,
      status: 'UPLOADED',
    });
  }

  const result = {
    documentStatuses: results,
    successCount: results.filter((r) => r.status !== 'FAILED').length,
    failCount: results.filter((r) => r.status === 'FAILED').length,
  };

  console.log('[FedEx] Documents uploaded:', result.successCount, '/', documents.length);
  result.documentStatuses.forEach((doc) => {
    console.log(`  - ${doc.documentType}: ${doc.fileName} (${doc.status})`);
  });
  return result;
}

module.exports = {
  getRates,
  createShipment,
  trackShipment,
  validateAddress,
  schedulePickup,
  cancelPickup,
  retrieveRegulatoryDocuments,
  uploadTradeDocuments,
};
