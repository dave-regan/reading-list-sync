const PROPERTIES = PropertiesService.getScriptProperties();
const CACHE = CacheService.getScriptCache();

// Wikipedia credentials.
// Set in Apps Script > Project Settings > Script Properties.
const USERNAME = PROPERTIES.getProperty('USERNAME');
const PASSWORD = PROPERTIES.getProperty('PASSWORD');

// API endpoints
const API_ENDPOINTS = {
  'AUTH': "https://en.wikipedia.org/wiki/Special:UserLogin",
  'LISTS': "https://en.wikipedia.org/api/rest_v1/data/lists/",
  'DEFAULT_LIST': "https://en.wikipedia.org/api/rest_v1/data/lists/110563/entries/",
  'EXTRACTS' : "https://en.wikipedia.org/w/api.php?format=json&action=query&prop=extracts&exintro&explaintext&redirects=0&titles="
}

// Interval between HTTP requests in milliseconds
const REQUEST_INTERVAL = 500;

// Cache TTL in seconds
const CACHE_TTL = 60 * 60 * 24 - 60;

// The cookies will be stored here
var COOKIES = {};

// Function that parses the "set-cookie" header and saves the values for later use
function updateCookies(cookiesRaw) {
  for (var i = 0; i < cookiesRaw.length; i++) {
    var cookie = cookiesRaw[i].split(";")[0].split("=");
    if (cookie.length === 2 && cookie[0] && cookie[1]) {
      COOKIES[cookie[0]] = cookie[1];
    }
  }
}

// Function that builds an HTTP header cookie value
function getCookieHeader() {
  const cookies = [];
  for (var name in COOKIES) {
    cookies.push(`${name}=${COOKIES[name]}`);
  }
  const cookiesString = cookies.join(";");
  return cookiesString;
}

// Function that fetches the login toking from the login page
function getLoginToken() {
  const requestOptions = {
    'method' : "get",
    'muteHttpExceptions': false
  }
  const response = UrlFetchApp.fetch(API_ENDPOINTS['AUTH'], requestOptions);
  const responseCode = response.getResponseCode();
  if (responseCode !== 200) {
    throw `HTTP error ${responseCode}`;
  }
  const responseData = response.getContentText();
  const loginTokenField = '<input name="wpLoginToken" type="hidden" value="';
  const loginTokenPageSplit = responseData.split(loginTokenField);
  if (loginTokenPageSplit.length !== 2) {
    throw "Login token wasn't found.";
  }
  const loginToken = loginTokenPageSplit[1].split('">')[0]
  if (!loginToken) {
    throw "Login token is empty.";
  }
  updateCookies(response.getAllHeaders()['Set-Cookie']);
  return loginToken;
}

// Function that performs authentication
function authenticate(username, password) {
  // First step
  Utilities.sleep(REQUEST_INTERVAL);
  const loginToken = getLoginToken();
  const requestHeaders = {
    'Cookie': getCookieHeader()
  };
  const requestPayload = {
    'title': "Special:UserLogin",
    'wpName': username,
    'wpPassword': password,
    'wpRemember': "1",
    'wpEditToken': "+\\",
    'authAction': "login",
    'wpLoginToken': loginToken,
    'geEnabled': "-1"
  };
  const requestOptions = {
    'method' : "post",
    'headers': requestHeaders,
    'payload' : requestPayload,
    'muteHttpExceptions': true,
    'followRedirects': false
  }
  const response = UrlFetchApp.fetch(API_ENDPOINTS['AUTH'], requestOptions);
  const responseCode = response.getResponseCode();
  if (responseCode !== 302) {
    throw `HTTP code ${responseCode} received instead of 302 during first step.`;
  }
  updateCookies(response.getAllHeaders()['Set-Cookie'])

  // Second step
  Utilities.sleep(REQUEST_INTERVAL);
  const request1Headers = {
    'Cookie': getCookieHeader()
  };
  const request1Options = {
    'method' : "get",
    'headers': request1Headers,
    'muteHttpExceptions': true,
    'followRedirects': false
  }
  const response1 = UrlFetchApp.fetch(response.getAllHeaders()['Location'], request1Options);
  const response1Code = response1.getResponseCode();

  if (response1Code !== 302) {
    throw `HTTP code ${response1Code} received instead of 302 during second step.`;
  }
  updateCookies(response1.getAllHeaders()['Set-Cookie'])

  // Third step
  Utilities.sleep(REQUEST_INTERVAL);
  const request2Headers = {
    'Cookie': getCookieHeader()
  };
  const request2Options = {
    'method' : "get",
    'headers': request2Headers,
    'muteHttpExceptions': true,
    'followRedirects': false
  }
  const response2 = UrlFetchApp.fetch(response1.getAllHeaders()['Location'], request2Options);
  const response2Code = response2.getResponseCode();

  if (response2Code !== 302) {
    throw `HTTP code ${response1Code} received instead of 302 during third step.`;
  }
  updateCookies(response2.getAllHeaders()['Set-Cookie']);
}

// Function that returns the reading lists with entries from either the API or the cache
function getDefaultList() {
  var usernameHash = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
                                              USERNAME,
                                              Utilities.Charset.US_ASCII);
  var cacheKey = `wikipedia#defaultList#${usernameHash}`;
  var defaultList = CACHE.get(cacheKey);
  if (defaultList) {
    return JSON.parse(defaultList);
  }
  // Perform authentication
  authenticate(USERNAME, PASSWORD);
  const requestHeaders = {
    'Cookie': getCookieHeader()
  };
  const requestOptions = {
    'method' : "get",
    'headers': requestHeaders,
    'muteHttpExceptions': true
  }
  const entriesEndpointUrl = API_ENDPOINTS['DEFAULT_LIST'];
  var currentEndpointUrl = entriesEndpointUrl;

  // Get the contents of the default list

  var defaultList = {};
  var listLength = 0;
  var moreItems = true;
  do {
    Utilities.sleep(REQUEST_INTERVAL);
    // Fetch the default list containing all entries
    var responseEntries = UrlFetchApp.fetch(currentEndpointUrl, requestOptions);
    const responseCode = responseEntries.getResponseCode();
    if (responseCode !== 200) {
      throw `HTTP error ${responseCode}`;
    }
    var responseEntriesDataJson = JSON.parse(responseEntries.getContentText());
    var entries = responseEntriesDataJson['entries'];
    for (var i = 0; i < entries.length; i++) {
      var currentTitle = entries[i].title;
      defaultList[currentTitle] = {
        "created": entries[i].created
      };
      listLength++;
    }
    if(responseEntriesDataJson.hasOwnProperty("next")){
      var nextListParam = encodeURIComponent(responseEntriesDataJson['next'].replace(/\\/,""));
      currentEndpointUrl = entriesEndpointUrl + "?next=" + nextListParam;
    } else {
      moreItems = false;
    }
  } while(moreItems);

  // get extracts for each item in list

  var j = 0;                          // Counter used to check the 50 batch limit
  var titlesParamString = "";         // String used to create the Wikipedia batch request
  const extractsEndpointUrl = API_ENDPOINTS['EXTRACTS'];

  for (let title in defaultList) {
    titlesParamString += title;
    j++;
    if ((j % 10 === 0) || (j === listLength)) {
      Utilities.sleep(REQUEST_INTERVAL);
      currentEndpointUrl = extractsEndpointUrl + encodeURIComponent(titlesParamString);
      var responseExtracts = UrlFetchApp.fetch(currentEndpointUrl, requestOptions);
      const extractsResponseCode = responseExtracts.getResponseCode();
      if (extractsResponseCode !== 200) {
        throw `HTTP error ${extractsResponseCode}`;
      }
      var responseExtractsDataJson = JSON.parse(responseExtracts.getContentText());
      var results = responseExtractsDataJson['query'].pages;
      for (let pageId in results) {
        var currentPage = decodeURIComponent(results[pageId].title);
        // Some titles have changed since being added to the reading list, so they won't be found
        if (defaultList.hasOwnProperty(currentPage)) {
          var currentPageExtract = results[pageId].extract; 
          if (currentPageExtract.length > 500) {
            currentPageExtract = currentPageExtract.substring(0,200);
          } else {
            currentPageExtract = currentPageExtract;
          }
          defaultList[currentPage].extract = currentPageExtract.replace(/(\r\n|\n|\r)/gm, "");
        }
      }
      titlesParamString = "";
    } else {
      titlesParamString += "|";
    }
  }

  CACHE.put(cacheKey, JSON.stringify(defaultList), CACHE_TTL);

  return defaultList; 
}

// Function that processes HTTP GET requests and returns JSON response
function doGet() {
  // const defaultList = getDefaultList();
  // var t = HtmlService.createTemplateFromFile('index');
  // t.entries = defaultList;
  // return t.evaluate();
  const defaultList = getDefaultList();
  return ContentService.createTextOutput(JSON.stringify(defaultList)).setMimeType(ContentService.MimeType.JSON); 
}