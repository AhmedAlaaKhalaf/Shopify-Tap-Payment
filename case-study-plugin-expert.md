# **<u>Case Study Brief</u>** 

###### **Technical Assessment Brief for Candidates** 

This case study evaluates your practical skills in developing a custom Magento 2 Payment Gateway extension and a Shopify payment plugin. You will construct functional integration modules adhering to platform best practices and integrating with Tap Payments REST APIs. 

## **Documentation & API References** 

Refer to the official Tap Payments developer documentation to retrieve sandbox test credentials and build API payloads: 

|**Resource**|**URL Reference**|
|---|---|
|**Testing Keys**|https://developers.tap.company/referenc<br>e/testing-keys|
|**Test Cards**|https://developers.tap.company/referenc<br>e/testing-cards|
|**Authorize API Endpoint**|https://developers.tap.company/referenc<br>e/authorize|
|**Charges API Endpoint**|https://developers.tap.company/referenc<br>e/charges|



### **Submission Guidelines & Code Authenticity** 

- **Strict Code Originality** : Do **NOT** use AI code generation tools (such as ChatGPT or GitHub Copilot) to write this plugin. Code created using automated tools contains identifiable structural patterns and will result in immediate disqualification. 

- **Technical Depth & Verification** : You must possess a thorough understanding of all submitted code. In the second-round technical interview, we will conduct an in-depth code walk-through focused on: 

   - Magento 2 Checkout Architecture and Payment Provider API integration. 

   - Magento versus Shopify payment integration patterns and session lifecycle management. 

### **1. Magento 2 Payment Plugin** 

## **Module & Admin Configuration Requirements** 

The payment gateway extension must add a dedicated configuration section under the Magento Admin panel ( **Stores > Configuration > Sales > Payment Methods** ). 

The following settings must be configurable by the administrator (you may add additional fields if required): 

|**Field Name**|**Input Type**|**Description / Encryption**<br>**Requirement**|
|---|---|---|
|||Enables or disables the|
|**Enable Gateway**|Dropdown Select|Tap payment method on<br>the storefront checkout.|
|**Test Public Key**|Text Input|Publishable API Key. Must<br>utilize Magento backend<br>encryption (obscure/<br>encrypted type).|



|**Field Name**|**Input Type**|**Description / Encryption**<br>**Requirement**|
|---|---|---|
|**Test Secret Key**|Text Input|Secret API Key. Must<br>utilize Magento backend<br>encryption (obscure/<br>encrypted type).|
|**Transaction Mode**|Dropdown Select|Options:**Authorize**or<br>**Charge**. Determines the<br>API endpoint called<br>during checkout.|



## **Payment Flow & Checkout Logic** 

##### **User Experience & API Integration** 

- **Place Order Trigger** : When the customer clicks the **Place Order** button during Magento checkout, the plugin intercepts the request and calls the Tap API (/v2/charges or /v2/authorize based on the configured **Transaction Mode** ). 

- **Customer Redirection** : Extract the transaction.url string from the Tap API response and redirect the customer to complete payment on the hosted checkout page. 

- **Payment Request Details** : Include the **Request redirect URL** Success URL of the platform) and **Request post URL** (webhook/IPN endpoint) in the API request payload. 

##### **Post-Payment Handling & Order Status Lifecycle** 

- **Successful Payment** : 

   - Update the Magento order status to **Processing** . 

   - Attach the returned Tap Transaction ID (chg_... or auth_...) to the order under the **Transactions** section in Magento Admin. 

   - Display a success page and confirmation message to the customer. 

- **Failed / Declined / Canceled Payment** : 

   - Set the order status to **Canceled** . 

   - Restore the customer's shopping cart items automatically. 

   - Redirect the customer back to the Shopping Cart. 

- Display a clear error/failure notice describing the transaction outcome. 

## **<u>2. Shopify Native Credit Card Payment Case Study</u>** 

**Goal:** Build a minimal **native (onsite) credit card** Shopify Payments App backend rather than an offsite redirect integration. 

#### **Problem** 

Implement a partner payments backend that: 

- Accepts Shopifyʼs **payment session** request for credit card payments. 

- Authorizes via a **mock processor** (stub card decryption if needed). 

- Finalizes the session with Shopify GraphQL paymentSessionResolve or paymentSessionReject. 

- Supports a basic **3DS path** : paymentSessionRedirect → confirm → resolve/reject. 

- Implements **one** post-authorization operation: **refund** or **void** (select one and document your choice). 

Docs: Payment processing · <u>Request reference</u> · Payments Apps API 

#### **In Scope** 

- Payment Session URL endpoint that responds with 200 OK promptly, handling further processing asynchronously if needed. 

- Persist session state (INITIATED → RESOLVED / REJECTED, plus 3DS states if used). 

- Idempotent handling of Shopify payment id (preventing duplicate finalizations or charges). 

- OAuth install **or** hard-coded Partner app token for a dev store (either is fine — document which). 

- Structured logs for the payment lifecycle. 

#### **Out of Scope** 

- Simultaneously implementing capture, void, and refund operations (select only one post-auth operation). 

- Merchant Admin UI, BNPL/offsite methods, production encryption/HSM, chargebacks. 

- Publishing a live app listing. 

#### **Deliverables** 

- Code repository containing a concise README (setup and testing instructions). 

- Sequence diagrams covering both **non-3DS** and **3DS** payment flows (a single summary page is sufficient). 

- Documentation notes outlining stubbed components and production hardening recommendations. 

#### **Evaluation Criteria** 

|**Criteria**|**What “goodˮ looks like**|
|---|---|
|**Lifecycle**|Correct mutation order; session finalized<br>once.|
|**3DS**|Redirect → confirm → resolve/reject<br>modeled correctly.|
|**Reliability**|Idempotent on retries/duplicates.|
|**Clarity**|Readable code + honest stubs.|



