<?php
require_once 'baseFunction.php';

/**
 * class TGCron
 */
class TGDelta
{
	private $helpers;
	
	/**
	 * construct
	 */
	function __construct() {
		$this->helpers = new baseFunction();
	}
	
	/**
	 * getData($data=[])
	 */
	public function getData($address='')
	{
		$users = $this->getTGUsers();
		if (
			empty($users) || 
			!is_array($users)||
			empty($users['users']) || 
			!is_array($users['users'])||
			empty($users['query']) || 
			!is_array($users['query'])
		) {
			return false;
		}
		
		$data = $this->getDataUsers($users['query']);
		if (empty($data) || !is_array($data)) {
			return false;
		}

		$bots = $this->getDataTGBots();
		if (empty($bots) || !is_array($bots)) {
			return false;
		}
		
		
		//print_r($data);
		exit;
		
		
		
		
		$path = dirname(__FILE__).'/WalletValidator.php';
		if (!file_exists($path)) {
			return false;
		}
				
		require_once($path);
		if (!class_exists('WalletValidator')) {
			return false;		
		}	
		
		
		
		
		
		
		
		
		

		foreach ($users as $value) {
			
			$bot_data = $this->helpers->getDataTGBot($value['id_bot']);
			$user_data = $this->getUserData($value['id']);

			
					
					
					//if (!empty($bot_data) && is_array($bot_data) && !empty($bot_data['bot_token'])) {
						//$this->sendMessage(1, $value, $bot_data['bot_token']);
					//}
				

		}	
	}

	/**
	 * sendData($data= [], $token='')
	 */
	public function sendMessage($type=0, $data= [], $token='')
	{
		if (
			empty($data) || 
			!is_array($data) ||
			empty($data['from_id']) ||
			empty($token) ||
			empty($type)
		) {
			return false;
		}
		
		if ($type==1) {
			$send['text'] = $this->helpers->formatWalletBalance($data);
		}
		
		$send['chat_id'] = $data['from_id'];
		$send['parse_mode'] = 'Markdown';
		$send['disable_web_page_preview'] = true;

		return $this->helpers->sendData($send, $token);
	}

	/**
	 * getDataUsers()
	 */
	private function getDataUsers($query=[]) 
	{
		if (empty($query) || !is_array($query)) {
			return false;
		}
		
		$str_query = @implode(', ', $query);
		if (empty($str_query) || !is_string($str_query)) {
			return false;
		}
		
		$sql = '
			SELECT
				`id_record`,
				`id_user`,
				`balance`,
				`protocols`,
				`datetime`
			FROM `001_userdata` 
			WHERE `deleted` = 0
			AND `balance`<>""
			AND `id_user` IN ('.$str_query.')
			ORDER BY `id_record` DESC
		';
		
		$result = $this->helpers->queryParams($sql, [], 'fetchAll');
		if (!empty($result) && !empty($result['completed']) && is_array($result['completed'])) {
			$data = [];
			foreach ($result['completed'] as $value) {
				$data[$value['id_user']][$value['datetime']] = [
					'id_user' => $value['id_user'],
					'balance' => $value['balance'],
					'protocols' => $value['protocols'],
					'datetime' => $value['datetime'],
				];
			}
			
			foreach ($data as &$userRecords) {
				usort($userRecords, function($a, $b) {
					return strtotime($b['datetime']) - strtotime($a['datetime']);
				});
			}
			
			
			
			print_r($data);
		}
		
		
		
		exit;
	}
	
	/**
	 * getDataTGBots()
	 */
	private function getDataTGBots() 
	{
		$sql = '
			SELECT
				`id_bot`,
				`bot_token`
			FROM `001_chatbot` 
			WHERE `deleted` = 0
		';

		$result = $this->helpers->queryParams($sql, [], 'fetchAll');
		
		if (!empty($result) && !empty($result['completed']) && is_array($result['completed'])) {
			$bots = [];
			foreach ($result['completed'] as $value) {
				$bots[$value['id_bot']] = $value['bot_token'];
			}
			
			if (!empty($bots)) {
				return $bots;
			}
		}
	
		return false;	
	}

	/**
	 * getTGUsers()
	 */
	private function getTGUsers() 
	{
		$sql = '
			SELECT
				`id`,
				`from_id`,
				`id_bot`,
				`from_first_name`,
				`from_last_name`,
				`from_username`
			FROM `001_subscribe`
			WHERE `deleted` = 0
			AND `from_id` <> 0
		';
		
		$params = [];

		$result = $this->helpers->queryParams($sql, $params, 'fetchAll');
		if (!empty($result) && !empty($result['completed']) && is_array($result['completed'])) {
			$users = [];
			$query = [];
			foreach ($result['completed'] as $value) {
				$users[$value['id']] = [
					'id' => $value['id'],
					'from_id' => $value['from_id'],
					'id_bot' => $value['id_bot'],
					'from_first_name' => $value['from_first_name'],
					'from_last_name' => $value['from_last_name'],
					'from_username' => $value['from_username'],
				];
				
				$query[$value['id']] = $value['id'];
			}
			
			
			
			return ['users'=>$users, 'query' => $query];
		}
	
		return false;	
	}
	
	/**
	 * class($className=__CLASS__)
	 */ 
	public static function tg($className=__CLASS__)
	{
		return new $className;
	}
}