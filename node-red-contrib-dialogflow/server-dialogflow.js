const helper  = require('node-red-viseo-helper')
const botmgr  = require('node-red-viseo-bot-manager')
const CARRIER = "GoogleHome"

// --------------------------------------------------------------------------
//  NODE-RED
// --------------------------------------------------------------------------


module.exports = function(RED) {
    const register = function(config) {
        RED.nodes.createNode(this, config);
        var node = this;

        start(RED, node, config);
        this.on('close', (done)  => { stop(node, config, done) });
    }
    RED.nodes.registerType("dialogflow-server", register);
}

let LISTENERS_REPLY = {};
let LISTENERS_PROMPT = {};

const {dialogflow, SimpleResponse, Carousel, SignIn, TransactionDecision, TransactionRequirements, OrderUpdate, Button, BasicCard, Permission, Suggestions, Image} = require('actions-on-google');
let app = dialogflow();

const start = (RED, node, config) => {  

    // Start HTTP Route
    let uri = '/dialogflow-server/';
    app.fallback(conv => { 
        return new Promise(function(resolve, reject) {
            receive(conv, node, config, resolve, reject);
        }); 
    });


    RED.httpNode.post(uri, app);

    // Add listener to reply
    let listenerReply = LISTENERS_REPLY[node.id] = (srcNode, data, srcConfig) => { reply(node, data, config) }
    helper.listenEvent('reply', listenerReply)

    let listenerPrompt = LISTENERS_PROMPT[node.id] = (srcNode, data, srcConfig) => { prompt(node, data, config) }
    helper.listenEvent('prompt', listenerPrompt)

}

const stop = (node, config, done) => {
    let listenerReply = LISTENERS_REPLY[node.id]
    helper.removeListener('reply', listenerReply)

    let listenerPrompt = LISTENERS_PROMPT[node.id]
    helper.removeListener('prompt', listenerPrompt)
    done();
}

// ------------------------------------------
//  LRU REQUESTS
// ------------------------------------------

const LRUMap = require('./lru.js').LRUMap;
const uuidv4 = require('uuid/v4');

// Should it be init in start() ?
let _CONTEXTS    = new LRUMap(CONFIG.server.contextLRU || 10000);
let _CONTEXT_KEY = 'contextId';

const getMessageContext = (message) => {
    if (message === undefined) return;

    let uuid    = helper.getByString(message, _CONTEXT_KEY);
    let context = _CONTEXTS.get(uuid);
    if (!context) {
        context = {};
        let convId = helper.getByString(message, 'address.conversation.id');
              uuid = convId + '-' + uuidv4();
              helper.setByString(message, _CONTEXT_KEY, uuid);
        _CONTEXTS.set(uuid, context);
    }
    return context;
}

// ------------------------------------------
//  RECEIVE
// ------------------------------------------

const receive = (conv, node, config, resolve, reject) => {
    // node.warn({ "RECEIVED" : conv});

    if (!conv || !conv.request) {
        node.warn({error: 'Empty request received', content: conv});
        return;
    }

    let data = botmgr.buildMessageFlow({ message : conv }, {
        userLocale: 'message.request.user.locale',
        userId:     'message.request.user.userId', 
        convId:     'message.request.conversation.conversationId',
        payload:    'message.request.inputs[0].rawInputs[0].query',
        inputType:  'message.request.inputs[0].rawInputs[0].inputType',
        source:     CARRIER
    })

    data.user.id = data.user.id || data.user._id;
    delete  data.user._id;
    data.user.accessToken = data.message.request.user.accessToken;

    let context = getMessageContext(data.message)
    context.conv = conv;
    context.resolve = resolve;
    context.reject = reject;

    if (conv.request.inputs[0].arguments !== undefined && 
        conv.request.inputs[0].arguments.length > 0) {
        data.message.text = conv.request.inputs[0].arguments[0].textValue;
    }
    else if (conv.request.inputs[0].rawInputs !== undefined && 
        conv.request.inputs[0].rawInputs.length > 0) {
        data.message.text = conv.request.inputs[0].rawInputs[0].query;
    }

    // Handle Prompt
    let convId  = botmgr.getConvId(data)
    if (botmgr.hasDelayedCallback(convId, data.message)) {
        return;
    }

    // Trigger received message
    helper.emitEvent('received', node, data, config);
    node.send([data, data]);

}

// ------------------------------------------
// PROMPT
// ------------------------------------------

const prompt = (node, data, config) => {
    // node.warn({ "PROMPT" : data});

    const next = function() {
        if (helper.countListeners('prompt') === 1) {
            helper.fireAsyncCallback(data);
        }
    }

    // Assume we send the message to the current user address
    let address = botmgr.getUserAddress(data)
    if (!address || address.carrier !== CARRIER) return next();

    //GEO LOCATION
    if (
        data.prompt.request &&
        data.prompt.request.device && 
        data.prompt.request.device.location
    ) {
        data.user.location = data.prompt.request.device.location;
    }

    //IDENTITY
    if (
        data.prompt.request &&
        data.prompt.request.user &&
        data.prompt.request.user.profile) {
        //EMAIL
        if (data.prompt.request.user.profile.email) {
            data.user.profile.email = data.prompt.request.user.profile.email;
        }
        //NAME
        if (data.prompt.request.user.profile.displayName) {
            data.user.profile.displayName = data.prompt.request.user.profile.displayName;
            data.user.profile.givenName = data.prompt.request.user.profile.givenName;
            data.user.profile.familyName = data.prompt.request.user.profile.familyName;
        }
    }

    next();
}


// ------------------------------------------
//  REPLY
// ------------------------------------------

const reply = (node, data, config) => { 
    try {

        let address = botmgr.getUserAddress(data)
        if (!address || address.carrier !== CARRIER) return false;

        // The address is not used because we reply to HTTP Response
        let context = data.prompt ? getMessageContext(data.prompt)
                                  : getMessageContext(data.message)
        let conv = context.conv;

        let resolve = context.resolve;
        let reject = context.reject;

        // Building the message
        let message = getMessage(data.reply);

        // node.warn({ REPLY: message, receive: data.message, rep: data.reply})

        if (!message || message.data.length === 0) return false;
        let endMsg = message.data.pop();
        for (let m of message.data) conv.ask(m);

        if (message.expectUserResponse === false) conv.close(endMsg);
        else conv.ask(endMsg);
        
        // Trap the event in order to continue
        helper.fireAsyncCallback(data);

        resolve();

    } catch(ex){ node.warn(ex); }

}

// ------------------------------------------
//  MESSAGES
//  https://github.com/api-ai/fulfillment-webhook-nodejs/blob/master/functions/index.js
// ------------------------------------------

// https://api.ai/docs/fulfillment#response
// doc : https://actions-on-google.github.io/actions-on-google-nodejs/modules/conversation_response.html
// doc : https://actions-on-google.github.io/actions-on-google-nodejs/modules/conversation_question.html

const getMessage = exports.getMessage = (replies) => {

    if (!replies) return;
    let msg = { expectUserResponse : false, data : [] }

    // Test if carousel
    let items = [];
    for (let i=0; i<replies.length; i++) {
        let reply = replies[i];

        if (i==0) {
            if (reply.type !== "card" && reply.type !== "text" && reply.type !== "quick") break;
            let text   = reply.text || reply.quicktext || reply.subtitle || reply.title;
            let speech = reply.speech || text;
            
            msg.data.push(new SimpleResponse({speech: speech, text: text }))

            // Quick replies
            if (reply.type === 'quick'){

                let suggestions = []
                for (let button of reply.buttons){

                    if (button.action && button.action === 'askLocation') {
                        msg.data = [new Permission({context: text || '', permissions: "DEVICE_PRECISE_LOCATION" })];
                        continue;
                    } 
                    if (button.action && button.action === 'askIdentity') {
                        msg.data = [new Permission({context: text || '', permissions: ["NAME", "EAP_ONLY_EMAIL"] })];
                        continue;
                    }

                    if ("string" === typeof button) suggestions.push(button) // btn.optionInfo = { key: button, synonyms: [button] }
                    else suggestions.push(button.title);
                }

                msg.data.push(new Suggestions(suggestions));
            }

            continue;
        }
        else if (reply.type !== "card") {
            items = [];
            break;
        }

        let item = { 
            title: reply.title, 
            description: reply.subtitle || '', 
            optionInfo: { key: reply.title, synonyms: [] }
        };

        if (reply.prompt) msg.expectUserResponse = true;
        if (reply.attach) {
            item.image = new Image({ 
                url: helper.absURL(reply.attach), 
                alt: reply.subtitle || reply.title
            })
        }
        if (reply.buttons) {
            let button = reply.buttons[0];
            if ("string" === typeof button) item.optionInfo.key = button ;
            else {
                item.optionInfo.key = button.value
                item.optionInfo.synonyms.push(button.title)
            }
        }

        items.push(item) ;
    }

    if (items.length > 1) {
        msg.data.push(new Carousel({ imageDisplayOptions: 'DEFAULT', items: items }));
        return msg;
    }
    else msg.data = [];

    for (let i=0; i<replies.length; i++) {

        // Not only cards
        let reply = replies[i];
        if (reply.prompt) msg.expectUserResponse = true;

        // Signin
        if (reply.type === 'signin'){
            msg.data.push(new SignIn());
            continue;
        }

        // Transaction
        if (reply.type === "transaction") {
            if (reply.intent == "confirm") {

                let items = []
                let totalPrice = 0

                for (let item of reply.orderItems) {
                    let units = String(Math.trunc(price));
                    let nanos = String(price).replace(/.*\./, '');
                        nanos = (nanos + '000000000').substring(0,9);
                        nanos = (price < 0) ? Number('-' + nanos) : Number(nanos);

                    items.push({
                        name: item.name,
                        id: item.name.toLowerCase().replace(/\s/g, '_'),
                        price: { 
                            amount: { currencyCode: 'EUR', units: units, nanos: nanos }, 
                            type: 'ESTIMATE'
                        },
                        quantity: 1,
                        type: 'REGULAR',
                        image: {
                            url: item.imageUrl,
                            accessibilityText: item.name
                        },
                        subLines: [{note: item.description}]
                    })

                    totalPrice += item.price
                }

                let units = String(Math.trunc(totalPrice));
                let nanos = String(totalPrice).replace(/.*\./, '');
                    nanos = (nanos + '000000000').substring(0,9);
                    nanos = (totalPrice < 0) ? Number('-' + nanos) : Number(nanos);

                let options = {
                    proposedOrder: {
                        id: reply.orderId,
                        cart: {
                            merchant: {
                                id: reply.merchant.toLowerCase().replace(/\s/g, '_'),
                                name: reply.merchant
                            },
                            linesItem: items
                        },
                        totalPrice: {
                            amount: { currencyCode: 'EUR', units: units, nanos: nanos }, 
                            type: 'ESTIMATE'
                        }
                    }
                }

                if (totalPrice > 0) {
                    options.paymentOptions = {
                        actionProvidedOptions: {
                            type: 'ON_FULFILLMENT',
                            displayName: "Règlement en magasin"
                        }
                    }
                }

                msg.data.push(new TransactionDecision(options));
                continue;

            } 
            
            if (reply.intent == "requirement_check") {
                msg.data.push(TransactionRequirements());
                continue;
            }
        }

        // Receipt
        if (reply.receipt !== undefined) {

            let orderUpdateObject = {
                actionOrderId: reply.receipt.orderId, 
                orderState: { 
                    label: reply.receipt.orderStateNam, 
                    state: reply.receipt.orderState
                },
                infoExtension: {},
                orderManagementActions: [],
                updateTime: new Date().toISOString()
            };

            orderUpdateObject.infoExtension['RECEIPT'] = { userVisibleOrderId: reply.receipt.orderId };

            for (let action of reply.receipt.orderActions) {
                orderUpdateObject.orderManagementActions.push({button: {openUrlAction: {url: action.url}, title: action.title}, type: action.type})
            }

            msg.data.push(new OrderUpdate(orderUpdateObject));
        }

        // Image
        if (reply.type === 'media') {
            msg.data.push(new Image({ url: helper.absURL(reply.media), alt: '[image]'}));
            continue;
        }

        // Card
        if (reply.type === "card") {
            let options = { 
                buttons: [],
                subtitle: reply.subtitle,
                text: reply.text || reply.quicktext,
                title: reply.title
            }

            if (reply.media || reply.attach) {
                options.image = { url: helper.absURL(reply.attach), accessibilityText: reply.title || "[image]" }
                options.imageDisplayOptions = 'CROPPED';
            }

            if (reply.buttons) {
                for (let btn of reply.buttons){
                    
                    if (btn.action !== 'openUrl') continue;
                    options.buttons.push(new Button({ title: btn.title, openUrlAction: { url: helper.absURL(btn.value)}}));
                }
            }
            
            msg.data.push(new BasicCard(options));
            continue;
        }

        // Simple text and quick replies
        if (reply.type === 'text' || reply.type === 'quick') {
            let text = reply.text || reply.quicktext;
            if (!text && reply.title) text = reply.title + ' ' + (reply.subtitle || '');
            let speech = reply.speech || text;
            
            msg.data.push(new SimpleResponse({speech: speech, text: text }))

            // Quick replies
            if (reply.type === 'quick'){

                let suggestions = []
                for (let button of reply.buttons){

                    if (button.action && button.action === 'askLocation') {
                        msg.data = [new Permission({context: text || '', permissions: "DEVICE_PRECISE_LOCATION" })];
                        continue;
                    } 
                    if (button.action && button.action === 'askIdentity') {
                        msg.data = [new Permission({context: text || '', permissions: ["NAME", "EAP_ONLY_EMAIL"] })];
                        continue;
                    }

                    if ("string" === typeof button) suggestions.push(button) // btn.optionInfo = { key: button, synonyms: [button] }
                    else suggestions.push(button.title);
                }

                msg.data.push(new Suggestions(suggestions));
            }
            continue;
        }
    }

    return msg;
}

