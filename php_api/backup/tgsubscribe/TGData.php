<?php
require_once 'baseFunction.php';

/**
 * class TGData
 * str token
 * str encryptedData
 * int tgBotName
 */
class TGData
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
	public function getData($data=[])
	{
		$path = dirname(__FILE__).'/RSAEncryption.php';
		if (!file_exists($path)) {
			exit(json_encode([
				'error'=>1,
				'message'=>'Server error 1009, please contact technical support',
			]));
		}
				
		require_once($path);
		if (!class_exists('RSAEncryption')) {
			exit(json_encode([
				'error'=>1,
				'message'=>'Server error 1010, please contact technical support',
			]));		
		}	
		
		$rsa = new RSAEncryption();
		$decryptedData = $rsa->decryptOAEP($data['encryptedData']);
		if (empty($decryptedData)) {
			exit(json_encode([
				'error'=>1,
				'message'=>'Server error 1011, please contact technical support',
			]));
		}
		
		if (!empty($decryptedData['error'])) {
			exit($decryptedData);
		}
		
		$addresses = @json_decode($decryptedData['data'], true);
		if (empty($addresses) || !is_array($addresses)) {
			exit(json_encode([
				'error'=>1,
				'message'=>'Server error 1012, please contact technical support',
			]));
		}

		if (empty($addresses['solana']) && empty($addresses['aptos'])) {
			exit(json_encode([
				'error'=>1,
				'message'=>'Server error 1012, please contact technical support',
			]));
		}

		$path = dirname(__FILE__).'/WalletValidator.php';
		if (!file_exists($path)) {
			exit(json_encode([
				'error'=>1,
				'message'=>'Server error 10013, please contact technical support',
			]));
		}
				
		require_once($path);
		if (!class_exists('WalletValidator')) {
			exit(json_encode([
				'error'=>1,
				'message'=>'Server error 1014, please contact technical support',
			]));		
		}	
		
		$address_solana = '';
		if (!empty($addresses['solana'])) {
			$solanaAddress = trim($addresses['solana']);
			if (WalletValidator::validateSolanaAddress($solanaAddress)) {
				if (!WalletValidator::isZeroAddress($solanaAddress, 'solana')) {
					$address_solana = $solanaAddress;
				}
			}
		}
		
		$address_aptos = '';
		if (!empty($addresses['aptos'])) {
			$aptosAddress = trim($addresses['aptos']);
			if (WalletValidator::validateAptosAddress($aptosAddress)) {
				if (!WalletValidator::isZeroAddress($aptosAddress, 'aptos')) {
					// Нормализуем Aptos адрес (приводим к нижнему регистру с префиксом 0x)
					$cleanAddress = strtolower($aptosAddress);
					if (strpos($cleanAddress, '0x') !== 0) {
						$cleanAddress = '0x' . $cleanAddress;
					}
					$address_aptos = $cleanAddress;
				}
			}
		}
		
		if (empty($address_solana) && empty($address_aptos)) {
			exit(json_encode([
				'error'=>1,
				'message'=>'Server error 1015, please contact technical support',
			]));
		}

		$data_bot = $this->getTGBot($data['tgBotName']);
		if (empty($data_bot)) {
			exit(json_encode([
				'error'=>1,
				'message'=>'Server error 1016, please contact technical support',
			]));
		}
		
		//$this->deleteWebhook($data_bot['bot_token']);
		$hook = $this->getWebhook($data_bot['bot_token']);
		if (empty($hook) || empty($hook['ok'])) {
			exit(json_encode([
				'error'=>1,
				'message'=>'Server error 1018, please contact technical support',
			]));
		}
		
		if (empty($hook['url'])) {
			$results = $this->setWebhook($data_bot['bot_token']);
			if (empty($hook) || empty($hook['ok']) || empty($hook['result'])) {
				exit(json_encode([
					'error'=>1,
					'message'=>'Server error 1019, please contact technical support',
				]));
			}
		}

		$update = [
			'id_bot' => $data_bot['id_bot'],
			'address_aptos' => $address_aptos,
			'address_solana' => $address_solana,
			'token' => $data['token'],
		];
		
		if ($this->createUserSubscribe($update)) {
			exit(json_encode([
				'error'=>0,
				'message'=>'Success',
			]));
		}
		
		exit(json_encode([
			'error'=>1,
			'message'=>'Server error 1017, please contact technical support',
		]));
	}

	/**
	 * setSubscribe($data=[])
	 */
	public function setSubscribe($data=[])
	{
		$update = [
			'update_id' => 0,
			'message_id' => 0,
			'date' => 0,
			'text' => '',
			'from_id' => 0,
			'from_is_bot' => 0,
			'from_first_name' => '',
			'from_last_name' => '',
			'from_username' => '',
			'from_language_code' => '',
			'chat_id' => 0,
			'chat_first_name' => '',
			'chat_last_name' => '',
			'chat_username' => '',
			'chat_type' => '',
		];
		
		if (!empty($data) && is_array($data)) {
			
			if (!empty($data['update_id'])) {
				$update['update_id'] = (int) $data['update_id'];
			}
			
			if (!empty($data['message']) && is_array($data['message'])) {
			
				if (!empty($data['message']['message_id'])) {
					$update['message_id'] = (int) $data['message']['message_id'];
				}
				
				if (!empty($data['message']['date'])) {
					$update['date'] = (int) $data['message']['date'];
				}
				
				if (!empty($data['message']['text'])) {
					$update['text'] = $data['message']['text'];
					$update['text'] = str_replace('/start', '', $update['text']);
					$update['text'] = trim($update['text']);	
				}
				
				if (!empty($data['message']['from']) && is_array($data['message']['from'])) {
					
					if (!empty($data['message']['from']['id'])) {
						$update['from_id'] = (int) $data['message']['from']['id'];
					}
					
					if (!empty($data['message']['from']['is_bot'])) {
						$update['from_is_bot'] = (int) $data['message']['from']['is_bot'];
					}
					
					if (!empty($data['message']['from']['first_name'])) {
						$update['from_first_name'] = $data['message']['from']['first_name'];
					}
					
					if (!empty($data['message']['from']['last_name'])) {
						$update['from_last_name'] = $data['message']['from']['last_name'];
					}
					
					if (!empty($data['message']['from']['username'])) {
						$update['from_username'] = $data['message']['from']['username'];
					}
					
					if (!empty($data['message']['from']['language_code'])) {
						$update['from_language_code'] = $data['message']['from']['language_code'];
					}
					
				}
				
				if (!empty($data['message']['chat']) && is_array($data['message']['chat'])) {
					
					if (!empty($data['message']['chat']['id'])) {
						$update['chat_id'] = (int) $data['message']['chat']['id'];
					}
					
					if (!empty($data['message']['chat']['first_name'])) {
						$update['chat_first_name'] = $data['message']['chat']['first_name'];
					}
					
					if (!empty($data['message']['chat']['last_name'])) {
						$update['chat_last_name'] = $data['message']['chat']['last_name'];
					}
					
					if (!empty($data['message']['chat']['username'])) {
						$update['chat_username'] = $data['message']['chat']['username'];
					}
					
					if (!empty($data['message']['chat']['type'])) {
						$update['chat_type'] = $data['message']['chat']['type'];
					}
					
				}
			}
		}

		if (!empty($update['text'])) {
			$data_bot = $this->getTGUser($update['text']);
			if (!empty($data_bot) && !empty($data_bot['id'])) {
				$users = $this->getTGUsers($update['from_id']);
				if (!empty($users) && is_array($users)) {
					foreach ($users as $value) {
						if ($this->deleteUserSubscribe($value['id'])) {
							
						}
					}
				}  
				
				$token = $update['text'];
				unset($update['text']);
				if ($this->updateUserSubscribe($update, $data_bot['id'])) {

					$results = $this->helpers->getDataTGBot($data_bot['id_bot']);
					if (!empty($results) && is_array($results)) {
						
						if (!empty($results['bot_token'])) {
							$data_bot['bot_token'] = $results['bot_token'];
						}
						
						if (!empty($results['bot_name'])) {
							$data_bot['bot_name'] = $results['bot_name'];
						}
						
						if (!empty($results['bot_identify'])) {
							$data_bot['bot_identify'] = $results['bot_identify'];
						}
					}
		
					$btn[] = [
						'text' => '📊 Portfolio',
						'callback_data' => '/getportfolio '.$token,
					];

					
					/*
					$send['reply_markup'] = json_encode([
						'inline_keyboard' => [$btn]
					]);
					*/

					$send['reply_markup'] = json_encode([
						'keyboard' => [$btn],
						'resize_keyboard' => true,
						'one_time_keyboard' => false,
						'persistent' => true
					]);

					$send['text'] = 'You connected the wallet '.substr_replace($data_bot['address_aptos'], '...', 8, -8).', the bot will send daily updates about the portfolio';
					$send['chat_id'] = $update['from_id'];
					//$send['parse_mode'] = 'HTML';
	
					return $this->helpers->sendData($send, $data_bot['bot_token']);
				}
			}
			
			return true;
		}	
	}
	
	/**
	 * setSubscribe($data=[])
	 */
	public function sendPortfolio($data=[])
	{
		if (empty($data)) {
			return false;
		}
		
		$token = str_replace('/getportfolio', '', $data);
		$token = trim($token);	
		if (empty($token)) {
			return false;
		}

		$data_bot = $this->getTGUser($token);
		if (
			empty($data_bot) || 
			empty($data_bot['address_aptos']) || 
			empty($data_bot['from_id']) ||
			empty($data_bot['id_bot'])
		) {
			return false;
		}
		
		$results = $this->helpers->getDataTGBot($data_bot['id_bot']);
		if (empty($results) || empty($results['bot_token'])) {
			return false;
		}
		
		$data = [
			'balance' => $this->helpers->getBalance($data_bot['address_aptos']),
			'protocols' => $this->helpers->getProtocols($data_bot['address_aptos']),
		];
		
		$send['text'] = $this->helpers->formatWalletBalance($data);
		$send['chat_id'] = $data_bot['from_id'];
		$send['parse_mode'] = 'Markdown';
		$send['disable_web_page_preview'] = true;

		return $this->helpers->sendData($send, $results['bot_token']);
	}
	
	/**
	 * setSubscribe($data=[])
	 */
	public function sendPortfolio2($data=[])
	{
		if (empty($data) || empty($data['message']) || empty($data['message']['from']) || empty($data['message']['from']['id'])) {
			return false;
		}
		
		$id = (int) $data['message']['from']['id'];
		if (empty($id)) {
			return false;
		}
		
		$data_bot = $this->getSubscribe($id);

		if (
			empty($data_bot) || 
			empty($data_bot['address_aptos']) || 
			empty($data_bot['from_id']) ||
			empty($data_bot['id_bot'])
		) {
			return false;
		}
		
		$results = $this->helpers->getDataTGBot($data_bot['id_bot']);
		if (empty($results) || empty($results['bot_token'])) {
			return false;
		}
		
		$data = [
			'balance' => $this->helpers->getBalance($data_bot['address_aptos']),
			'protocols' => $this->helpers->getProtocols($data_bot['address_aptos']),
		];
		
		$send['text'] = $this->helpers->formatWalletBalance($data);
		$send['chat_id'] = $data_bot['from_id'];
		$send['parse_mode'] = 'Markdown';
		$send['disable_web_page_preview'] = true;

		return $this->helpers->sendData($send, $results['bot_token']);
	}
	
	/**
	 * getWebhook($bot_id, $bot_token) 
	 */
	private function getWebhook($bot_token='') 
	{
		if (empty($bot_token)) {
			return false;
		}
		
		$url = $this->helpers->TelegramBotApiUrl . $bot_token . '/getWebhookInfo';
		return $this->helpers->sendActionToBot($url);
	}
	
	/**
	 * setWebhook($id_bot, $bot_token) 
	 */
	private function setWebhook($bot_token='') 
	{
		if (empty($bot_token)) {
			return false;
		}
		
		$url = $this->helpers->TelegramBotApiUrl . $bot_token . '/setWebhook?url=' . $this->helpers->BotApiUrl;
		
		return $this->helpers->sendActionToBot($url);
	}
	
	/**
	 * deleteWebhook($bot_token)
	 */
	private function deleteWebhook($bot_token='') 
	{
		if (empty($bot_token)) {
			return false;
		}
		
		$url = $this->helpers->TelegramBotApiUrl . $bot_token . '/deleteWebhook';
		
		return $this->helpers->sendActionToBot($url);
	}
	
	/**
	 * createUserSubscribe($update=[]) 
	 */
	private function createUserSubscribe($update=[]) 
	{
		if (empty($update) || !is_array($update)) {
			return false;
		}
		
		$sql = '
			INSERT INTO `001_subscribe` 
			(`creation_date`, `id_bot`, `token`, `address_aptos`, `address_solana`) 
			VALUES 
			(:creation_date, :id_bot, :token, :address_aptos, :address_solana)
		';

		$params = [
			':creation_date' => date('Y-m-d H:i:s'),
			':id_bot' => !empty($update['id_bot']) ? $update['id_bot'] : 0,
			':token' => !empty($update['token']) ? $update['token'] : '',
			':address_aptos' => !empty($update['address_aptos']) ? $update['address_aptos'] : '',
			':address_solana' => !empty($update['address_solana']) ? $update['address_solana'] : '',
		];

		$result = $this->helpers->queryParams($sql, $params);
		if (!empty($result) && !empty($result['completed'])) {
			return true;
		}

		return false;
	}
	
	/**
	 * updateUserSubscribe($update=[]) 
	 */
	private function updateUserSubscribe($update=[], $id=0) 
	{
		if (empty($update) || !is_array($update) || empty($id)) {
			return false;
		}
		
		$update['id'] = $id;
		$new_update = [];
		foreach ($update as $key=>$value) {
			$new_update[':'.$key] = $value;
		}
	
		$sql = '
			UPDATE `001_subscribe`  
			SET 
				`update_id` = :update_id,
				`message_id` = :message_id,
				`api_date` = :date,
				`from_id` = :from_id,
				`from_is_bot` = :from_is_bot,
				`from_first_name` = :from_first_name,
				`from_last_name` = :from_last_name,
				`from_username` = :from_username,
				`from_language_code` = :from_language_code,
				`chat_id` = :chat_id,
				`chat_first_name` = :chat_first_name,
				`chat_last_name` = :chat_last_name,
				`chat_username` = :chat_username,
				`chat_type` = :chat_type

			WHERE `id` = :id
			AND deleted=0
		';

		$result = $this->helpers->queryParams($sql, $new_update);
		if (!empty($result) && !empty($result['completed'])) {
			return true;
		}

		return false;
	}
	
	/**
	 * deleteUserSubscribe($update=[], $id=0) 
	 */
	private function deleteUserSubscribe($id=0) 
	{
		if (empty($id)) {
			return false;
		}
		
		$sql = '
			UPDATE `001_subscribe`  
			SET `deleted` = :deleted,
			    `deleted_date` = :deleted_date
			WHERE `id` = :id
		';
		
		$params = [
			':deleted_date' => date('Y-m-d H:i:s'),
			':deleted' => 1,
			':id' => $id,
		];

		$result = $this->helpers->queryParams($sql, $params);
		if (!empty($result) && !empty($result['completed'])) {
			return true;
		}

		return false;		
	}

	/**
	 * getTGBot($bot_name='') 
	 */
	private function getTGBot($bot_name='') 
	{
		if (empty($bot_name)) {
			return false;
		}
		
		$sql = '
			SELECT
				`id_bot`,
				`bot_token`
			FROM `001_chatbot` 
			WHERE `bot_identify` = :bot_identify
			AND `deleted` = 0
			LIMIT 1
		';
		
		$params = [
			':bot_identify' => $bot_name,
		];

		$result = $this->helpers->queryParams($sql, $params, 'fetch');
		
		if (!empty($result) && !empty($result['completed']) && !empty($result['completed']['id_bot']) && !empty($result['completed']['bot_token'])) {
			return [
				'id_bot'=>$result['completed']['id_bot'],
				'bot_token' => $result['completed']['bot_token'],
			];
		}
	
		return false;	
	}
	
	/**
	 * getTGUser($token='')
	 */
	private function getTGUser($token='') 
	{
		if (empty($token)) {
			return false;
		}
		
		$sql = '
			SELECT
				`id`,
				`id_bot`,
				`address_aptos`,
				`address_solana`,
				`from_id`
			FROM `001_subscribe` 
			WHERE `token` = :token
			AND `deleted` = 0
			LIMIT 1
		';
		
		$params = [
			':token' => $token,
		];

		$result = $this->helpers->queryParams($sql, $params, 'fetch');
		
		if (!empty($result) && !empty($result['completed']) && !empty($result['completed']['id'])) {
			return [
				'id'=>$result['completed']['id'],
				'id_bot'=>$result['completed']['id_bot'], 
				'address_aptos'=>$result['completed']['address_aptos'],
				'address_solana'=>$result['completed']['address_solana'], 
				'from_id' => $result['completed']['from_id'], 
			];
		}
	
		return false;	
	}
	
	/**
	 * getSubscribe($from_id=0)
	 */
	public function getSubscribe($from_id=0)
	{
		if (empty($from_id)) {
			return false;
		}
		
		$sql = '
			SELECT
				`id`,
				`id_bot`,
				`address_aptos`,
				`address_solana`,
				`from_id`
			FROM `001_subscribe` 
			WHERE `from_id` = :from_id
			AND `deleted` = 0
			ORDER BY `id` DESC
			LIMIT 1
		';
		
		$params = [
			':from_id' => $from_id,
		];

		$result = $this->helpers->queryParams($sql, $params, 'fetchAll');		
		if (!empty($result) && !empty($result['completed']) && !empty($result['completed'][0])) {
			return [
				'id'=>$result['completed'][0]['id'],
				'id_bot'=>$result['completed'][0]['id_bot'], 
				'address_aptos'=>$result['completed'][0]['address_aptos'],
				'address_solana'=>$result['completed'][0]['address_solana'], 
				'from_id' => $result['completed'][0]['from_id'], 
			];
		}
	}
	
	/**
	 * getTGUser($token='')
	 */
	private function getTGUsers($id=0) 
	{
		if (empty($id)) {
			return false;
		}
		
		$sql = '
			SELECT
				`id`
			FROM `001_subscribe` 
			WHERE `from_id` = :from_id
			AND `deleted` = 0
		';
		
		$params = [
			':from_id' => $id,
		];

		$result = $this->helpers->queryParams($sql, $params, 'fetchAll');
		if (!empty($result) && !empty($result['completed']) && is_array($result['completed'])) {
			return $result['completed'];
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