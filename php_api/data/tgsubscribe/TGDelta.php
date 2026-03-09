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

		foreach ($users['users'] as $idUser => $value) {
			if (
				empty($value['from_id']) ||
				empty($value['id_bot']) ||
				empty($data[$idUser]['current'])
			) {
				continue;
			}

			if (empty($bots[$value['id_bot']])) {
				continue;
			}

			$current = $data[$idUser]['current'];
			$balance = json_decode($current['balance'], true);
			$protocols = json_decode($current['protocols'], true);

			if (
				empty($balance) || !is_array($balance) ||
				empty($protocols) || !is_array($protocols)
			) {
				continue;
			}

			$sendData = [
				'from_id' => $value['from_id'],
				'balance' => $balance,
				'protocols' => $protocols,
			];

			if (!empty($data[$idUser]['yesterday']['protocols'])) {
				$yesterdayProtocols = json_decode($data[$idUser]['yesterday']['protocols'], true);
				if (!empty($yesterdayProtocols) && is_array($yesterdayProtocols)) {
					$sendData['previous_total_assets'] = $this->helpers->calculateTotalAssetsFromProtocols($yesterdayProtocols);
				}
			}

			$this->sendMessage(1, $sendData, $bots[$value['id_bot']]);
		}

		return true;
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
			$previousTotalAssets = isset($data['previous_total_assets']) && is_numeric($data['previous_total_assets'])
				? (float)$data['previous_total_assets']
				: null;
			$send['text'] = $this->helpers->formatWalletBalance($data, $previousTotalAssets);
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
			$grouped = [];
			foreach ($result['completed'] as $value) {
				if (empty($value['id_user'])) {
					continue;
				}
				$idUser = (int)$value['id_user'];
				if (!isset($grouped[$idUser])) {
					$grouped[$idUser] = [];
				}
				$grouped[$idUser][] = [
					'id_user' => $idUser,
					'balance' => $value['balance'],
					'protocols' => $value['protocols'],
					'datetime' => $value['datetime'],
				];
			}

			$data = [];
			foreach ($grouped as $idUser => $records) {
				usort($records, function($a, $b) {
					$aTs = is_numeric($a['datetime']) ? (int)$a['datetime'] : (int)strtotime($a['datetime']);
					$bTs = is_numeric($b['datetime']) ? (int)$b['datetime'] : (int)strtotime($b['datetime']);
					return $bTs - $aTs;
				});

				if (empty($records[0])) {
					continue;
				}

				$current = $records[0];
				$currentTs = is_numeric($current['datetime']) ? (int)$current['datetime'] : (int)strtotime($current['datetime']);
				$previous = null;

				foreach ($records as $idx => $record) {
					if ($idx === 0) {
						continue;
					}
					$recordTs = is_numeric($record['datetime']) ? (int)$record['datetime'] : (int)strtotime($record['datetime']);
					if ($recordTs < $currentTs) {
						$previous = $record;
						break;
					}
				}

				$data[$idUser] = [
					'current' => $current,
					'yesterday' => $previous,
				];
			}

			return $data;
		}

		return false;
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