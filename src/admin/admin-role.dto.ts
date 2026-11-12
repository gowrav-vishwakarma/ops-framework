import { PartialType } from '@nestjs/mapped-types';
import { Type } from 'class-transformer';
import { IsArray, IsNotEmpty, IsObject, IsOptional, IsString, Matches, MaxLength, ValidateNested } from 'class-validator';
import type { AclScope, Limits } from '../auth/auth-user.js';

export class AdminGrantDto {
  @IsString()
  @IsNotEmpty()
  code: string;

  @IsString()
  @MaxLength(40)
  scope: AclScope;

  @IsOptional()
  @IsObject()
  limits?: Limits;
}

export class CreateAdminRoleDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name: string;

  @IsString()
  @Matches(/^[A-Za-z0-9_]{2,40}$/, { message: 'Code: 2-40 letters, digits or _' })
  code: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  description?: string | null;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AdminGrantDto)
  permissions?: AdminGrantDto[];
}

export class UpdateAdminRoleDto extends PartialType(CreateAdminRoleDto) {}

export class ReplaceAdminGrantsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AdminGrantDto)
  items: AdminGrantDto[];
}
