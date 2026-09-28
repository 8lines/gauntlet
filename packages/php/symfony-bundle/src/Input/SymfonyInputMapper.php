<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Input;

use EightLines\Gauntlet\Core\Contract\InputMapper;
use EightLines\Gauntlet\Core\Contract\InputMappingException;
use EightLines\Gauntlet\Core\Json\JsonObject;
use EightLines\Gauntlet\Core\Json\JsonOwnership;
use EightLines\Gauntlet\Core\Problem\ValidationError;
use Symfony\Component\Serializer\Normalizer\DenormalizerInterface;
use Symfony\Component\Validator\Validator\ValidatorInterface;

final readonly class SymfonyInputMapper implements InputMapper
{
    public function __construct(
        private DenormalizerInterface $serializer,
        private ValidatorInterface $validator,
    ) {
    }

    /** @param class-string $class */
    public function map(JsonObject $input, string $class): object
    {
        $values = get_object_vars($input->jsonSerialize());
        $reflection = new \ReflectionClass($class);
        $constructor = $reflection->getConstructor();
        if ($constructor === null || !$constructor->isPublic()) {
            throw $this->singleError('', '#/type', 'mapping');
        }

        $parameters = [];
        $required = [];
        foreach ($constructor->getParameters() as $parameter) {
            $parameters[$parameter->getName()] = true;
            if (!$parameter->isDefaultValueAvailable()) {
                $required[$parameter->getName()] = true;
            }
        }
        foreach (array_keys($values) as $name) {
            if (!isset($parameters[$name])) {
                throw $this->singleError(
                    '/' . self::pointerToken($name),
                    '#/additionalProperties',
                    'additionalProperties',
                );
            }
        }
        foreach (array_keys($required) as $name) {
            if (!array_key_exists($name, $values)) {
                throw $this->singleError('/' . self::pointerToken($name), '#/required', 'required');
            }
        }

        try {
            $mapped = $this->serializer->denormalize($values, $class);
        } catch (\Throwable) {
            throw $this->singleError('', '#/type', 'mapping');
        }
        if (!is_object($mapped) || !$mapped instanceof $class) {
            throw $this->singleError('', '#/type', 'mapping');
        }

        $errors = [];
        foreach ($this->validator->validate($mapped) as $violation) {
            $errors[] = new ValidationError(
                instancePath: self::propertyPathToPointer($violation->getPropertyPath()),
                schemaPath: '#',
                keyword: 'validation',
                message: 'Invalid value.',
                params: JsonOwnership::object([]),
            );
        }
        usort(
            $errors,
            static fn (ValidationError $left, ValidationError $right): int =>
                $left->instancePath <=> $right->instancePath,
        );
        if ($errors !== []) {
            throw new InputMappingException($errors);
        }

        return $mapped;
    }

    private function singleError(string $instancePath, string $schemaPath, string $keyword): InputMappingException
    {
        return new InputMappingException([
            new ValidationError(
                instancePath: $instancePath,
                schemaPath: $schemaPath,
                keyword: $keyword,
                message: 'Invalid value.',
                params: JsonOwnership::object([]),
            ),
        ]);
    }

    private static function propertyPathToPointer(string $path): string
    {
        if ($path === '') {
            return '';
        }

        $segments = [];
        preg_match_all('/(?:^|\.)([^.\[]+)|\[([^\]]+)\]/', $path, $matches, PREG_SET_ORDER);
        foreach ($matches as $match) {
            $segments[] = $match[1] !== '' ? $match[1] : $match[2];
        }

        return '/' . implode('/', array_map(self::pointerToken(...), $segments));
    }

    private static function pointerToken(string $value): string
    {
        return str_replace(['~', '/'], ['~0', '~1'], $value);
    }
}
