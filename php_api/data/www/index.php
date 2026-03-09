<?php
$message = 'The requested URL was not found on this server.';
$page = '';
$requestPath = parse_url($_SERVER['REQUEST_URI']);
if (!empty($requestPath) && is_array($requestPath) && !empty($requestPath['query'])) {
	$pathArray = explode('&', $requestPath['query']);
	if (!empty($pathArray) && is_array($pathArray) && !empty($pathArray[0])) {
		$page = $pathArray[0];
	}
}

if ($page =='subscribe') {

	$input = file_get_contents('php://input');
	
	if (empty($input) || !is_string($input)) {
		exit("<!DOCTYPE HTML PUBLIC \"-//IETF//DTD HTML 2.0//EN\">\r\n<html><head>\r\n<title>404 Not Found</title>\r\n</head><body>\r\n<h1>Not Found</h1>\r\n<p>".$message."</p>\r\n<hr>\r\n<address>Apache/2.2 (FreeBSD) Server at aoserver.ru Port 80</address>\r\n</body></html>");
	}

	$data = @json_decode($input, true);
	if (empty($data) || !is_array($data) || empty($data['token']) || empty($data['encryptedData']) || empty($data['tgBotName'])) {			
		exit("<!DOCTYPE HTML PUBLIC \"-//IETF//DTD HTML 2.0//EN\">\r\n<html><head>\r\n<title>404 Not Found</title>\r\n</head><body>\r\n<h1>Not Found</h1>\r\n<p>".$message."</p>\r\n<hr>\r\n<address>Apache/2.2 (FreeBSD) Server at aoserver.ru Port 80</address>\r\n</body></html>");					
	}
	
	$path = dirname(__DIR__).'/tgsubscribe/TGData.php';
	if (!file_exists($path)) {
		exit(json_encode([
			'error'=>1,
			'message'=>'Server error 1001, please contact technical support',
		]));
	}
			
	require_once($path);
	if (!class_exists('TGData')) {
		exit(json_encode([
			'error'=>1,
			'message'=>'Server error 1002, please contact technical support',
		]));		
	}	
		
	$result = TGData::tg()->getData($data);
	exit($result);

} else if ($page =='tgData') {
	
	$input = file_get_contents('php://input');

	if (empty($input) || !is_string($input)) {
		return true;
	}

	$data = @json_decode($input, true);
	if (empty($data) || !is_array($data)) {			
		return true;
	}

	$path = dirname(__DIR__).'/tgsubscribe/TGData.php';
	if (!file_exists($path)) {
		return true;
	}
			
	require_once($path);
	if (!class_exists('TGData')) {
		return true;		
	}
	
	if (!empty($data)) {
		if (!empty($data['message'])) {
			
			if (!empty($data['message']['text'])) {
				if (preg_match('/^\/start/', $data['message']['text'])) {
					TGData::tg()->setSubscribe($data);
				}
				
				if (preg_match('/^📊 Portfolio/', $data['message']['text'])) {
					TGData::tg()->sendPortfolio2($data);	
				}
			}
			
		} else if (!empty($data['callback_query'])) {
			
			if (!empty($data['callback_query']['data'])) {
				if (preg_match('/^\/getportfolio/', $data['callback_query']['data'])) {
					TGData::tg()->sendPortfolio($data['callback_query']['data']);	
				}
			}	
		}
	} 
	
	return true;

} else {
	exit("<!DOCTYPE HTML PUBLIC \"-//IETF//DTD HTML 2.0//EN\">\r\n<html><head>\r\n<title>404 Not Found</title>\r\n</head><body>\r\n<h1>Not Found</h1>\r\n<p>".$message."</p>\r\n<hr>\r\n<address>Apache/2.2 (FreeBSD) Server at aoserver.ru Port 80</address>\r\n</body></html>");
}