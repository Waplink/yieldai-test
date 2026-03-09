<?php
$ip = $_SERVER['REMOTE_ADDR'];
if ($ip!='148.251.81.84') {
	//exit("<!DOCTYPE HTML PUBLIC \"-//IETF//DTD HTML 2.0//EN\">\r\n<html><head>\r\n<title>404 Not Found</title>\r\n</head><body>\r\n<h1>Not Found</h1>\r\n<p>".$message."</p>\r\n<hr>\r\n<address>Apache/2.2 (FreeBSD) Server at aoserver.ru Port 80</address>\r\n</body></html>");					
}

$path = dirname(__DIR__).'/tgsubscribe/TGDelta.php';
if (!file_exists($path)) {
	exit('TGDelta file not found');
}
			
require_once($path);
if (!class_exists('TGDelta')) {
	exit('TGDelta class not found');	
}	
		
TGDelta::tg()->getData();